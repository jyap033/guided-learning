# Chapter 4: State Machine Framework

*Part: NICo Architecture · 7 concepts · [curriculum](../curriculum.md#chapter-4)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

NICo has to drive real hardware through long lifecycles where a lot can go wrong. It discovers a BMC, pairs DPUs, flashes firmware, reboots, hands a host to a tenant, sanitises it, then does it all again. Any process can crash halfway through, any network call can time out, and two workers can end up looking at the same machine. This chapter covers the ideas NICo's state machine framework relies on to stay correct anyway.

We start with the big picture. NICo is a set of **microservices**, and NICo REST runs its multi-step operations on the **Temporal** workflow engine. Next is a small, concrete mechanism: **GCRA rate limiting**, which the DPU agent uses to protect identity signing. The rest of the chapter covers the database side of the state controllers: **transactions**, **idempotency**, **optimistic concurrency** (stale-write protection) and **WorkLock leases with fencing**.

Earlier chapters covered SQL, HTTP APIs, async programming and containers. This chapter explains why NICo's docs say things like "the framework does not guarantee exactly-once execution" and "keep database transactions short". It ends with a laptop build: a tiny state controller in Python and SQLite that survives crashes, races and rate limits without rebooting a fake BMC twice.

**By the end of this chapter you can:**

- Trace a request through NICo's microservices and explain why only the API Service reads and writes the site's system-state database (`nico_system_nico`)
- Describe what Temporal makes durable, list the namespaces NICo needs, and explain why Temporal activities still have to be idempotent
- Compute GCRA rate-limit decisions for the DPU agent's IMDS identity settings (3 requests/s, burst 8)
- Design short database transactions that never stay open across an external call, and choose a recoverable write order
- Write a version-guarded UPDATE that rejects stale writes, and explain what NICo does when one is rejected
- Use a lease plus a fence check so a worker that has lost ownership cannot commit protected writes

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [Microservices architecture](#microservices-architecture)
2. [Temporal workflow engine](#temporal-workflow-engine)
3. [Rate limiting (GCRA token bucket)](#rate-limiting)
4. [Database transaction](#database-transaction)
5. [Idempotency](#idempotency)
6. [Optimistic concurrency / stale-write protection](#optimistic-concurrency-stale-write-protection)
7. [WorkLock lease and fencing](#worklock-lease-and-fencing)
8. [Build task: Mini state controller: survive crashes, races and rate limits](#build-task)

<a id="microservices-architecture"></a>
## 1. Microservices architecture

*Builds on: HTTP and web APIs (ch. 3)*

### Before you read

- NICo's DHCP server answers BMCs on the physical network. Do you think it keeps its own database of IP leases? Guess why or why not.
- If one small service in a system crashes, what do you expect to happen to the others?

<details>
<summary>Answers</summary>

- **NICo's DHCP server answers BMCs on the physical network. Do you think it keeps its own database of IP leases? Guess why or why not.** No. The NICo DHCP server is stateless. It forwards requests to the API Service, which handles IP address management and is the only service that reads and writes the site's system-state database.
- **If one small service in a system crashes, what do you expect to happen to the others?** Ideally they keep running. Independent deployment and failure isolation are big reasons to split a system into services. Callers of the crashed service still need timeouts and retries, though.

</details>

### Explanation

A **microservices architecture** builds a system out of many small programs called **services**. Each one is deployed, restarted and scaled on its own. They talk to each other over the network instead of through function calls inside one process. The opposite is a **monolith**: one large program that does everything.

NICo's control plane, the **Site Controller**, is a suite of microservices running on a Kubernetes cluster inside the datacenter it manages. The cluster needs at least three nodes for high availability. All control plane services talk to each other over **mTLS/gRPC**. gRPC is an RPC framework that uses Protocol Buffers, which you covered earlier. In mTLS (mutual TLS), both sides present certificates, so each service proves who it is.

The central service is the **API Service (NICo Core)**, the single source of truth for the site. It is the **only** service that reads from and writes to the site's system-state database, `nico_system_nico` in PostgreSQL. It also runs the state machines for hosts, network segments and InfiniBand/NVLink partitions. The other site services do one job each and report to it:

- **DHCP Server**: stateless. It forwards requests to the API Service for IP management.
- **PXE Service**: serves boot artifacts. It fetches the correct one for each host from the API Service.
- **Hardware Health**: scrapes BMCs over Redfish and reports health alerts to the API Service.
- **Site Agent**: connects the site to **NICo REST** (the JSON API) through Temporal. NICo REST can then run centrally in the cloud while the site controller stays on-premises.

Agents also run on the managed hosts. Scout runs during discovery, and the DPU Agent polls the API Service every 30 seconds for the desired network configuration.

A note on "one owner": the rule covers the site's system state. Other NICo components such as NICo REST and NICo Flow have **their own separate** PostgreSQL databases for their own data (REST's data, Flow's rack tasks). They still don't write Core's `nico_system_nico`. Whenever they need site state changed, they ask Core.

The benefits of microservices are independent deployment, focused code and failure isolation. The costs:

1. Every call crosses a network, so it can be slow, time out, or succeed without you hearing back.
2. No single database transaction can span services.
3. You must decide which service owns each piece of data.

NICo handles point 3 by making Core the sole writer of site state, while each other component owns only its own database. Points 1 and 2 are the reason the rest of this chapter exists.

**Analogy.** Think of a restaurant kitchen with stations (grill, salad, pastry) and one head chef who holds the master order book. Each station does its own work, but only the head chef updates the book. When a station hears "table 4 wants fries", it passes the request on instead of writing it down. The pastry station might keep its own recipe binder, but that's not the order book. Where it breaks down: stations can shout across the room and get an instant, reliable answer. Services talk over a network where messages get lost or delayed, and a reply that never arrives tells you nothing about whether the work was done.

### Worked example: Trace a new BMC's first DHCP request through NICo

**Step 1: Identify the entry point.**

A host BMC powers on and broadcasts a DHCP request on the underlay network. The **NICo DHCP server** (a Kea hook plugin) receives it.

**Step 2: See the stateless hand-off.**

The hook extracts the MAC address, vendor class, relay address, circuit ID and remote ID. It then sends a gRPC `discover_dhcp()` request to **NICo Core** (the API Service). The DHCP server does not choose the IP address itself.

**Step 3: Locate where state lives.**

NICo Core tracks DHCP entries in its database by MAC address. It returns a `Machine` response with the network configuration (IP, gateway and so on), and the DHCP server passes that back to the BMC.

**Step 4: Follow the knock-on work.**

Once NICo knows the BMC's IP, **Site Explorer** probes it over Redfish (`GET /redfish/v1`), authenticates and collects inventory. The results become part of Core's state in `nico_system_nico`. No other site service writes that database.

**Step 5: Draw the lesson.**

All site state flows through one owner, so you could restart or scale the DHCP service without losing anything. The price is that every hop is a network call that can fail, so Core has to tolerate repeated or missing requests.

### Your turn: finish it

Fill in the blanks in this map of which NICo component talks to which, according to the NICo overview.

```text
| Component | Talks to | Protocol |
|---|---|---|
| DHCP Server | API Service | mTLS/gRPC |
| PXE Service | API Service | mTLS/gRPC |
| Hardware Health | Host and DPU BMCs | ___ |
| API Service | ___ (the only service that does) | SQL |
| Site Agent | NICo REST | via ___ |
```

<details>
<summary>Answer</summary>

Hardware Health talks to the BMCs over **Redfish HTTPS**. The API Service talks to **PostgreSQL**, specifically the `nico_system_nico` database. The Site Agent reaches NICo REST **via Temporal**.

</details>

### Your turn: on your own

Hardware Health notices a fan reporting 0 RPM on a host BMC. Describe where that information goes inside NICo. Then give two reasons the design doesn't let Hardware Health write the alert straight into `nico_system_nico`.

<details>
<summary>Hint 1</summary>

Check which service the overview says Hardware Health reports alerts to.

</details>

<details>
<summary>Hint 2</summary>

Think about what goes wrong when two services each write the same tables with their own rules.

</details>

<details>
<summary>Hint 3</summary>

Consider who runs the state machines that react to health changes.

</details>

<details>
<summary>Answer</summary>

Hardware Health reports the alert to the API Service over mTLS/gRPC (`InsertMachineHealthReport`). The API Service stores it, and its state machines react. Two reasons to route the alert through Core: (1) with one owner of the database there is one set of validation and concurrency rules, and no second writer racing the state machines. (2) Hardware Health stays simple and replaceable, and Core can change its schema without breaking other services. Core also needs one place to aggregate health and react to it.

</details>

### Explain it

In your own words: Letting every service read and write `nico_system_nico` directly would save network hops. Why does NICo let only the API Service touch it?

### Check

**1. Which NICo service is the only one that reads from and writes to the site's system-state database, `nico_system_nico`?**

A. The API Service (NICo Core)
B. Every Site Controller service, each with its own schema
C. NICo REST
D. The DHCP Server, because it stores IP leases

<details>
<summary>Answer</summary>

**A.** The API Service (NICo Core)

The overview says the API Service is the single source of truth and the only service with access to this database. The DHCP server is stateless and forwards to Core. NICo REST has its own database and reaches the site through the Site Agent. It doesn't write Core's database.

</details>

**2. What is a real cost of splitting a system into microservices?**

A. Calls between services cross a network and can time out or lose their reply
B. Services can no longer be restarted independently
C. You can no longer use more than one programming language
D. Every service has to share one process

<details>
<summary>Answer</summary>

**A.** Calls between services cross a network and can time out or lose their reply

Independent restarts and the freedom to mix languages are benefits, not costs. Sharing one process is what a monolith does. The real cost is network unreliability, which is what drives the idempotency and reconciliation rules later in this chapter.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [architecture/flow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/flow.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md)

<a id="temporal-workflow-engine"></a>
## 2. Temporal workflow engine

### Before you read

- A program that provisions a server runs 6 steps over 20 minutes. It crashes after step 4. Without special tooling, what usually happens when you restart it?
- Which three Temporal namespaces does NICo need?

<details>
<summary>Answers</summary>

- **A program that provisions a server runs 6 steps over 20 minutes. It crashes after step 4. Without special tooling, what usually happens when you restart it?** It starts again from step 1, or you have to work out by hand what already happened. A durable workflow engine records progress so the run can resume after step 4.
- **Which three Temporal namespaces does NICo need?** `cloud`, `site`, and one named after each site's UUID, registered once you know the UUID.

</details>

### Explanation

**Temporal** is a durable workflow orchestration engine. You write two kinds of code. A **workflow** is ordinary code that describes a multi-step process. **Activities** are the individual steps that touch the outside world, such as calling an API or power-cycling a machine.

The Temporal server stores every event in the workflow's **history**: "activity A scheduled", "activity A completed with result X", "timer fired". If a worker process dies, another worker picks up the workflow and **replays** the history to rebuild where it was, then carries on. When a step has already finished, its recorded result is reused instead of running the step again. For replay to work, workflow code must be deterministic: with the same inputs and history it makes the same decisions. Side effects belong in activities.

Temporal retries failed activities according to a retry policy, and that has a consequence. If a worker crashes *during* an activity, Temporal can't know whether the external effect happened, so it runs the activity again. Temporal makes the orchestration durable, but each activity still has to be safe to repeat. The idempotency lesson later in this chapter covers how.

How NICo uses Temporal:

- **NICo REST** runs multi-step operations on Temporal: instance provisioning, reboot (for example the `RebootInstance` workflow) and release.
- The **Site Agent** connects to NICo REST through Temporal. This is how a centrally hosted REST API delegates work to an on-premises site.
- **NICo Flow** stores rack tasks in its own PostgreSQL database and runs them through Temporal. Rule stages run in order, and the steps inside a stage run in parallel. A failed stage stops the task **without rolling back** earlier hardware actions.
- NICo needs three **namespaces** (isolated units inside one Temporal server): `cloud`, `site`, and one per site UUID. The validated server version is v1.22.6, with the frontend at `temporal-frontend.temporal.svc:7233`.

The NICo Core state controllers you'll study next are a separate mechanism. They resume work from database state rather than from Temporal history.

**Analogy.** Think of a flight's black box combined with a checklist. Each checklist item is logged the moment it finishes, so a replacement pilot can read the log and carry on from the right line. Where it breaks down: if the first pilot collapsed halfway through "lower landing gear", the log only says the item started. The new pilot has to check the gear before pulling the lever again. Temporal is in the same position when an activity is interrupted.

### Worked example: Run Temporal locally and register NICo's namespaces

**Step 1: Install the Temporal CLI.**

On macOS: `brew install temporal`. On Linux: `curl -sSf https://temporal.download/cli.sh | sh`, then add `~/.temporalio/bin` to your `PATH`. Check it with `temporal --version`.

**Step 2: Start a dev server.**

```bash
temporal server start-dev
```
This starts a single-process server with its frontend on `localhost:7233` (the same port NICo's cluster uses) and a web UI on `http://localhost:8233`. Leave it running.

**Step 3: Register the namespaces NICo expects.**

In a second terminal:
```bash
SITE_UUID=$(python3 -c 'import uuid; print(uuid.uuid4())')
for ns in cloud site "$SITE_UUID"; do
  temporal operator namespace create --namespace "$ns"
done
temporal operator namespace list | grep -E 'Name'
```
NICo's docs do the same thing with the older `tctl` tool: `tctl --ns cloud namespace register`, then the same for `site` and for the site UUID.

**Step 4: Connect it to NICo's install order.**

In the NICo prerequisites, Temporal is the last foundation service (ESO → cert-manager → PostgreSQL → Vault → Temporal). You register `cloud` and `site` while deploying NICo REST. The per-site UUID namespace comes later, after the site has been created, because that's when its UUID exists.

### Your turn: finish it

You've just created a site, and the REST API reports its UUID as `3f2a9c1e-7b44-4d0e-9a51-0c2d8e6f1b77`. Complete the registration commands from the NICo docs.

```text
tctl --ns cloud namespace register
tctl --ns site namespace register
tctl --ns ___ namespace register
```

<details>
<summary>Answer</summary>

`tctl --ns 3f2a9c1e-7b44-4d0e-9a51-0c2d8e6f1b77 namespace register`. The third namespace is named after the site UUID itself.

</details>

### Your turn: on your own

A NICo REST provisioning workflow has three activities: (1) allocate an IP, (2) power-cycle the host via the Site Agent, (3) mark the instance ready. Consider two separate crashes. In (a), the worker process is killed just after activity 1's completion was recorded. In (b), it is killed while activity 2 is in flight. What does Temporal do in each case, and what does that demand from activity 2?

<details>
<summary>Hint 1</summary>

What does the history contain at the moment of each crash?

</details>

<details>
<summary>Hint 2</summary>

In case (b), is there a recorded result for activity 2?

</details>

<details>
<summary>Hint 3</summary>

Think about whether Temporal can see inside the BMC.

</details>

<details>
<summary>Answer</summary>

(a) The history records activity 1 as completed. A new worker replays the history, reuses activity 1's stored result without running it again, and schedules activity 2. (b) The history shows activity 2 as scheduled or started but not completed. When it times out, Temporal retries it, so the power-cycle may be requested twice. Activity 2 must therefore be idempotent or reconcile first. Before issuing another reset, it should check whether the reboot already happened or use a stable operation ID.

</details>

### Explain it

In your own words: Temporal records every completed step durably. Why is that still not enough to guarantee that a host is power-cycled exactly once?

### Check

**1. Which NICo component connects to NICo REST through Temporal?**

A. The Site Agent
B. The DHCP Server
C. The DPU Agent
D. PostgreSQL

<details>
<summary>Answer</summary>

**A.** The Site Agent

The overview says the Site Agent maintains a Temporal connection to NICo REST. The DPU Agent polls the API Service over gRPC, and the DHCP Server forwards to Core over gRPC.

</details>

**2. In NICo Flow, a stage fails after earlier stages have flashed firmware. What happens to the earlier firmware changes?**

A. They stay in place; the task stops without rolling back earlier hardware actions
B. Temporal automatically rolls them back
C. PostgreSQL rolls them back with the task row
D. Flow retries the whole task from the beginning forever

<details>
<summary>Answer</summary>

**A.** They stay in place; the task stops without rolling back earlier hardware actions

The Flow page says this explicitly. Neither Temporal nor a database rollback can undo a completed hardware change. Undoing it would take a separate compensating operation.

</details>

**3. Why must Temporal workflow code be deterministic?**

A. Workers rebuild a workflow's position by replaying its history, which only works if the code makes the same decisions each time
B. Because Temporal runs workflows on GPUs
C. So the workflow can run without a server
D. Determinism makes activities exactly-once

<details>
<summary>Answer</summary>

**A.** Workers rebuild a workflow's position by replaying its history, which only works if the code makes the same decisions each time

Replay is how recovery works. Determinism doesn't make activities exactly-once; they can still be retried.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [architecture/flow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/flow.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md)

<a id="rate-limiting"></a>
## 3. Rate limiting (GCRA token bucket)

### Before you read

- A limiter allows 3 requests per second with a burst of 8. A tenant workload fires 20 requests at the same instant. Roughly how many get through immediately?
- Why might the DPU agent want to limit how often workloads can ask for identity tokens?

<details>
<summary>Answers</summary>

- **A limiter allows 3 requests per second with a burst of 8. A tenant workload fires 20 requests at the same instant. Roughly how many get through immediately?** About 8, the burst. After that, roughly one new permit appears every 1/3 second.
- **Why might the DPU agent want to limit how often workloads can ask for identity tokens?** Each request triggers a signing call to NICo Core (or a sign-proxy). A misbehaving workload could flood the signer, so the agent caps the sustained rate while still allowing short spikes.

</details>

### Explanation

**Rate limiting** caps how many requests a service accepts over time. The classic mental model is a **token bucket**. The bucket holds up to *burst* tokens and refills at *rate* tokens per second. Each request takes one token. If the bucket is empty, the request waits or is rejected. You get a sustained cap (the refill rate) plus room for short spikes up to the bucket size.

**GCRA** (Generic Cell Rate Algorithm) behaves the same way but stores just one number instead of a token count and a timestamp. That number is the **TAT**, the *theoretical arrival time*: when the next request would be "on schedule" if traffic arrived at exactly the sustained rate.

- Emission interval `T = 1 / rate`. For 3/s, T = 1/3 s.
- Burst tolerance `tau = (burst - 1) * T`, which is how far ahead of schedule you may run.
- On each request at time `now`: `tat = max(TAT, now)`. If `tat - now > tau`, reject (or wait). Otherwise allow and set `TAT = tat + T`.

GCRA is cheap, needs no background refill timer, and fits in one shared variable or a single database or Redis key.

**In NICo:** the DPU agent serves IMDS (instance metadata service) identity requests (`GET …/meta-data/identity`). It applies a GCRA limit configured in the agent's optional `[machine-identity]` section, not in the API site config:

| Setting | Default | Meaning |
|---|---|---|
| `requests-per-second` | 3 | Sustained admission rate (GCRA refill rate) |
| `burst` | 8 | Maximum burst above the sustained rate |
| `wait-timeout-secs` | 2 | How long a request may block waiting for a permit before failing |
| `sign-timeout-secs` | 5 | Timeout for the signing step itself |

The wait timeout matters. A request that can't get capacity within 2 seconds fails instead of queueing forever. After changing these settings, restart or redeploy the DPU agents. The exact behaviour right at the burst boundary (off by one or not) depends on the implementation; the model here is the standard textbook form.

**Analogy.** Picture a bouncer with a clicker who lets people in at a steady 3 per second but will admit a group of up to 8 arriving together, because the room has slack. Where it breaks down: a real bouncer can see the queue and the room. GCRA remembers only one timestamp and never checks who is already inside.

### Worked example: Simulate the DPU agent's default limiter in Python

**Step 1: Write the GCRA core with exact arithmetic.**

Floating-point rounding can flip a decision right at the boundary, so use `Fraction`.
```python
# gcra.py
from fractions import Fraction

class GCRA:
    def __init__(self, rate, burst):
        self.T = Fraction(1, rate)
        self.tau = (burst - 1) * self.T
        self.tat = Fraction(0)

    def allow(self, now):
        tat = max(self.tat, now)
        if tat - now > self.tau:
            return False
        self.tat = tat + self.T
        return True

if __name__ == "__main__":
    g = GCRA(rate=3, burst=8)
    print([g.allow(Fraction(0)) for _ in range(10)])
    print(g.allow(Fraction(1, 3)), g.allow(Fraction(1, 3)))
    print(g.allow(Fraction(1)))
```

**Step 2: Run it and read the burst.**

Run `python3 gcra.py`. The first line shows eight `True` followed by two `False`: the burst of 8 is used up at t=0.

**Step 3: Watch the refill.**

At t = 1/3 s, TAT is 8/3 and `tat - now = 7/3`, which equals `tau`, so one request is allowed. The second request at the same instant is rejected. That's exactly one permit per T.

**Step 4: Check the sustained rate.**

At t = 1 s, TAT is 3 and `tat - now = 2 ≤ 7/3`, so the request is allowed. Over long periods, admissions settle at 3 per second no matter how hard clients push.

### Your turn: finish it

Complete this GCRA `allow` method. It should reject a request that is too far ahead of schedule, and otherwise move the TAT forward by one interval.

```text
    def allow(self, now):
        tat = max(self.tat, now)
        if ___:
            return False
        self.tat = ___
        return True
```

<details>
<summary>Answer</summary>

First blank: `tat - now > self.tau`. Second blank: `tat + self.T`. Writing `self.tat + self.T` instead would be a bug after an idle period: the TAT would lag behind `now`, which allows an oversized burst.

</details>

### Your turn: on your own

Use the defaults: rate 3, burst 8, wait timeout 2 s. A workload sends 20 identity requests at t=0. Each request waits up to 2 s for a permit and then fails. About how many succeed, and when does the last success happen?

<details>
<summary>Hint 1</summary>

The first 8 pass at t=0. When is the next permit?

</details>

<details>
<summary>Hint 2</summary>

After the burst, one permit arrives every T = 1/3 s. How many intervals fit in 2 seconds?

</details>

<details>
<summary>Hint 3</summary>

2 s / (1/3 s) = 6. Add those to the burst.

</details>

<details>
<summary>Answer</summary>

About 8 succeed immediately. After that, waiting requests get a permit about every 1/3 s (at 1/3, 2/3, … up to 2 s), which is about 6 more. So roughly 14 succeed, the last near t = 2 s, and about 6 fail with a timeout. Whether the permit landing exactly on 2.0 s counts depends on the implementation's boundary check.

</details>

### Explain it

In your own words: Why does a rate limiter need both a sustained rate and a burst, rather than just a maximum number of requests per second?

### Check

**1. Where are the IMDS identity rate limits configured?**

A. In the DPU agent's optional `[machine-identity]` section
B. In `[machine_identity]` in the API site config
C. In the Temporal `site` namespace
D. In PostgreSQL's `nico_system_nico` database

<details>
<summary>Answer</summary>

**A.** In the DPU agent's optional `[machine-identity]` section

The Day 0 page says these limits are set on the agent and not stored in site config. The site config's `[machine_identity]` section (note the underscore) holds the enable switch, the algorithm and the encryption key ID.

</details>

**2. With `wait-timeout-secs = 2`, what happens to a request when no permit becomes available within 2 seconds?**

A. The agent fails the request instead of queueing it indefinitely
B. It is queued until a permit eventually arrives
C. It is forwarded to NICo Core without signing
D. The burst is temporarily raised

<details>
<summary>Answer</summary>

**A.** The agent fails the request instead of queueing it indefinitely

The docs say the timeout exists to avoid indefinite queueing. Raising the burst or skipping signing would defeat the point of the limiter.

</details>

**3. In GCRA, what single piece of state does the limiter keep?**

A. The theoretical arrival time (TAT)
B. A list of timestamps of every recent request
C. A background thread that adds tokens every T
D. The number of currently connected clients

<details>
<summary>Answer</summary>

**A.** The theoretical arrival time (TAT)

That's GCRA's appeal: one number, updated on each request, with no refill timer. Keeping a sliding log of timestamps is a different and more expensive algorithm.

</details>

**Sources:** [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md)

<a id="database-transaction"></a>
## 4. Database transaction

### Before you read

- You record "IP 10.0.0.5 is allocated" and "machine m1 has IP 10.0.0.5" as two separate writes. The process crashes between them. What's wrong with the data now?
- Is it a good idea to open a transaction, power-cycle a server over Redfish (around 30 s), then commit?

<details>
<summary>Answers</summary>

- **You record "IP 10.0.0.5 is allocated" and "machine m1 has IP 10.0.0.5" as two separate writes. The process crashes between them. What's wrong with the data now?** The IP is marked allocated but no machine has it, so the address leaks. A transaction makes both writes commit together or neither.
- **Is it a good idea to open a transaction, power-cycle a server over Redfish (around 30 s), then commit?** No. The transaction holds locks the whole time, and if it rolls back, the reboot still happened. NICo never keeps a transaction open across external calls.

</details>

### Explanation

A **database transaction** is a group of reads and writes that the database treats as one unit. It either **commits**, so every change becomes durable and visible together, or **rolls back**, so none of the changes happened. You start with `BEGIN` and finish with `COMMIT` or `ROLLBACK`. Transactions also isolate concurrent work: other sessions don't see your half-finished changes. They usually hold row locks until they end.

A transaction protects **database facts only**, and that limit shapes NICo's state handling. A rollback cannot undo a completed Redfish call to a BMC, a switch or a DPU. NICo's docs say plainly that the framework "does not make database changes and external I/O atomic."

NICo's transaction rules for state controllers:

- **State load:** read the object snapshot and controller state in a short transaction, and **commit before** the handler does any external work.
- **Related database changes:** keep them in one transaction when they have to agree with each other. The processor applies all handler-queued writes in one transaction. If one write fails with an operational error, the whole lot rolls back.
- **Database first:** commit a *recovery point* **before** the external call. A recovery point is a durable record such as "pending reboot, operation ID X". If that commit fails, skip the call.
- **External I/O first:** make the call with **no open transaction**, then start a *new* transaction for the follow-up write.

Why keep them short? Long transactions hold locks that block other workers. Timeouts can kill them and roll back work you thought was done. They also tempt you to believe the external call is "inside" the transaction, which it never is. NICo also notes that a handler timeout can roll back an uncommitted transition. The next run then sees the previous durable state and has to recover from there.

**Analogy.** Think of a shopping cart at checkout. You pay for everything in the cart together, or you walk away with nothing. Where it breaks down: if you already ate a sample at the deli counter, abandoning the cart doesn't un-eat it. External effects are those samples.

### Worked example: See commit and rollback with Python's sqlite3

**Step 1: Create a tiny IP pool.**

```python
# txn_demo.py
import sqlite3

conn = sqlite3.connect("txn.db")
conn.executescript("""
DROP TABLE IF EXISTS ips; DROP TABLE IF EXISTS ifaces;
CREATE TABLE ips(addr TEXT PRIMARY KEY, allocated INTEGER NOT NULL);
CREATE TABLE ifaces(machine TEXT PRIMARY KEY, addr TEXT NOT NULL);
INSERT INTO ips VALUES ('10.0.0.5', 0);
""")
```

**Step 2: Group the two writes.**

`with conn:` commits if the block finishes and rolls back if it raises.
```python
try:
    with conn:
        conn.execute("UPDATE ips SET allocated = 1 WHERE addr = '10.0.0.5'")
        raise RuntimeError("crash before second write")
        conn.execute("INSERT INTO ifaces VALUES ('m1', '10.0.0.5')")
except RuntimeError as e:
    print("failed:", e)

print(conn.execute("SELECT * FROM ips").fetchall())
```

**Step 3: Observe the rollback.**

Run `python3 txn_demo.py`. It prints `[('10.0.0.5', 0)]`. The first UPDATE was undone, so the IP didn't leak.

**Step 4: Commit the happy path.**

Delete the `raise` line and run the script again. Now `allocated` is `1` and `ifaces` has the row: both writes committed together.

**Step 5: Notice what the transaction can't cover.**

Suppose you added `requests.post(bmc_url, ...)` inside the `with` block, before the raise. The rollback would undo the IP rows, but the BMC would already have acted. That's why NICo commits a recovery point first and makes external calls outside any open transaction.

### Your turn: finish it

Complete this "database first" pattern. It must commit a recovery point *before* the external call, make the call with no open transaction, then record the result in a **new** transaction.

```text
def reboot_machine(conn, machine_id, op_id, call_bmc):
    with conn:
        conn.execute(
            "INSERT INTO ops(op_id, machine_id, status) VALUES (?, ?, 'pending')",
            (op_id, machine_id),
        )
    result = ___
    with ___:
        conn.execute(
            "UPDATE ops SET status = ? WHERE op_id = ?",
            (result, op_id),
        )
```

<details>
<summary>Answer</summary>

First blank: `call_bmc(machine_id, op_id)`. It runs outside any `with conn:` block, so no transaction is open. Second blank: `conn`, which starts a fresh transaction for the follow-up write. If the first `with conn:` raises, the function exits before the BMC is ever called.

</details>

### Your turn: on your own

A colleague's handler does this: BEGIN → read machine → send Redfish `GracefulRestart` → wait up to 10 minutes for the host to come back → UPDATE machine state → COMMIT. List three concrete problems with it. Then rewrite it as a sequence of short transactions and external calls.

<details>
<summary>Hint 1</summary>

What happens to row locks during those 10 minutes?

</details>

<details>
<summary>Hint 2</summary>

If the COMMIT fails or the handler times out, what does the database say, and what did the host actually do?

</details>

<details>
<summary>Hint 3</summary>

Split it into: load (commit), recovery point (commit), external call (no txn), later observation and write (new txn).

</details>

<details>
<summary>Answer</summary>

Problems: (1) Locks are held for minutes and block other workers. (2) A timeout or failed commit rolls back the state change while the host really did reboot, so the database and reality disagree and nothing records the attempt. (3) If the process crashes mid-wait, nothing durable says a reboot was issued, so the next run may reboot again. Rewrite: (a) a short transaction loads state and commits; (b) a short transaction commits a recovery point (`pending_reboot`, operation ID, requested-at time); (c) the Redfish reset is sent with no transaction open; (d) the handler returns `Wait`; (e) later iterations observe the host, for example by checking for a reboot timestamp newer than the requested-at time, and then record completion and the transition in a new short transaction.

</details>

### Explain it

In your own words: Why can't a database transaction make "update the machine row" and "power-cycle the BMC" atomic, even if both happen between BEGIN and COMMIT?

### Check

**1. In NICo's state handling, when does the state-load transaction commit?**

A. Before the handler performs external work
B. After the handler's Redfish calls finish
C. Only when the resource reaches Ready
D. Never; it stays open for the controller's lifetime

<details>
<summary>Answer</summary>

**A.** Before the handler performs external work

The state-handling page says the processor reads the snapshot in a short transaction and commits it before any external work. Holding it open across calls is exactly the anti-pattern NICo avoids.

</details>

**2. With the "database first" order, what should happen if committing the recovery point fails?**

A. Skip the external call
B. Make the external call anyway and retry the commit later
C. Make the external call inside the failed transaction
D. Roll back the BMC

<details>
<summary>Answer</summary>

**A.** Skip the external call

Without a durable recovery point, nothing records that the call was attempted, so recovery after a crash would be guesswork. And there's no way to roll back a BMC.

</details>

**3. The processor applies all queued handler-owned writes, and one of them fails with an operational error. What happens to the others?**

A. They are all rolled back together
B. Those before the failure stay committed
C. Only the failed write is retried
D. They are committed and the failure is logged

<details>
<summary>Answer</summary>

**A.** They are all rolled back together

They share one transaction, so it's all or nothing. The processor then tries to persist an error outcome in a new transaction.

</details>

**Sources:** [architecture/state_handling.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_handling.md)

<a id="idempotency"></a>
## 5. Idempotency

### Before you read

- Which is safe to send twice: "set fan mode to HIGH" or "increase fan speed by 10%"?
- A request to the BMC times out. Did the reboot happen?

<details>
<summary>Answers</summary>

- **Which is safe to send twice: "set fan mode to HIGH" or "increase fan speed by 10%"?** "Set fan mode to HIGH". Repeating it gives the same result. Repeating the increase moves the speed further each time.
- **A request to the BMC times out. Did the reboot happen?** You can't tell. The request might not have arrived, might have half-run, or might have fully succeeded with only the reply lost. NICo treats a timed-out call as ambiguous and reconciles before retrying.

</details>

### Explanation

An operation is **idempotent** if doing it twice (or ten times) leaves the system in the same state as doing it once. `x = 5` is idempotent; `x = x + 1` is not. HTTP `PUT` of a full resource is designed to be idempotent, while a `POST` that creates something usually isn't.

NICo cares because its state-controller framework **does not guarantee exactly-once execution**. A handler can run again after a crash, after a timeout, after another processor takes over a stale queue claim, or after an invalidated iteration. Temporal can retry activities too. So NICo requires handlers to make their database changes **and** their external effects safe to retry and reconcile.

Techniques:

- **Desired-state operations:** express the call as "make it so" ("boot order = DPU first") rather than "do a thing".
- **Idempotency key / stable operation ID:** attach an ID derived from durable state. The receiver remembers the IDs it has handled and returns the original result instead of acting again.
- **Check before acting:** observe whether the effect already exists.

When the outcome of a previous attempt is unclear, NICo classifies it:

- **Absent:** retry only if repetition is safe.
- **Complete and desired:** adopt it and persist completion.
- **Partial or unwanted:** finish, compensate or remove it, but only through a documented safe operation.
- **Unknown:** keep observing safely, or **fail closed**: keep the recovery point, don't advance, and record an actionable error.

A real example from the rack state machine: the switch certificate batch is **non-idempotent**. If RMS can't find the persisted job, NICo goes to `Error` rather than resubmitting. The ScaleUpFabricManager V2 request, by contrast, is an **idempotent desired state**, so if RMS has lost the job, NICo simply resubmits it.

One more example: NICo's *explicit enqueue* is idempotent. Asking to enqueue a resource that is already queued doesn't create a second queue entry.

**Analogy.** A lift call button is idempotent: pressing it five times calls the lift once. Where it breaks down: the button needs no ID because there's one lift and one "called" flag. Real systems often need an operation ID to tell "the same request again" apart from "a genuinely new request that looks identical".

### Worked example: Make a fake reboot endpoint retry-safe with an idempotency key

**Step 1: Start with the unsafe version.**

```python
reboots = []

def reboot_unsafe(machine):
    reboots.append(machine)
    return "ok"

reboot_unsafe("m1"); reboot_unsafe("m1")  # client retried after a timeout
print(len(reboots))  # 2: the host rebooted twice
```

**Step 2: Derive a stable operation ID from durable state.**

The caller builds the ID from facts that don't change between retries, such as the machine ID plus the controller-state version it read: `op_id = f"{machine}-reboot-v{version}"`. A retry of the same attempt gets the same ID. A later, genuinely new reboot happens at a higher version, so it gets a new ID.

**Step 3: Have the receiver remember IDs.**

```python
reboots, seen = [], {}

def reboot(machine, op_id):
    if op_id in seen:
        return seen[op_id]
    reboots.append(machine)
    seen[op_id] = "ok"
    return "ok"

reboot("m1", "m1-reboot-v1"); reboot("m1", "m1-reboot-v1")
print(len(reboots))  # 1
reboot("m1", "m1-reboot-v2")
print(len(reboots))  # 2: a deliberate second reboot
```

**Step 4: Handle integrations that offer no keys.**

A plain Redfish `ComputerSystem.Reset` doesn't remember your IDs. In that case, persist a recovery point (such as a requested-at timestamp). On retry, look for evidence first, and reissue the reset only if the evidence says the reboot is absent.

The rack state machine works this way. A reboot batch completes when every request is cleared and every host reports a Scout reboot timestamp later than the persisted batch timestamp. Be precise about what that evidence shows. The rack doc notes that the timestamp **does not prove that this request caused the reboot**. It only shows that *some* reboot happened after the recovery point. That's enough for the rack's barrier, which only needs every host to have rebooted since the batch started, but it is not proof of causation. If your logic needs "my reset did it", you need stronger correlation data.

### Your turn: finish it

Complete this receiver so that a repeated `op_id` returns the stored result without applying the effect again.

```text
def apply_once(store, op_id, effect):
    if ___:
        return store[op_id]
    result = effect()
    store[op_id] = ___
    return result
```

<details>
<summary>Answer</summary>

First blank: `op_id in store`. Second blank: `result`. In a real system, recording the ID and applying the effect must be made durable together or reconciled. Otherwise a crash between the two reopens the window.

</details>

### Your turn: on your own

For each operation, say whether it is naturally idempotent. If it isn't, say how a NICo handler could make retries safe. (a) Set host boot order to DPU first. (b) Redfish `GracefulRestart`. (c) Submit the RMS switch certificate batch. (d) Mark an IP as allocated to machine m1.

<details>
<summary>Hint 1</summary>

Ask: does doing it a second time change anything beyond what the first time did?

</details>

<details>
<summary>Hint 2</summary>

For (b) and (c), think about the rack state machine's choices: evidence checks, and going to Error.

</details>

<details>
<summary>Hint 3</summary>

For (d), think about a desired-state write keyed by machine.

</details>

<details>
<summary>Answer</summary>

(a) Idempotent: it's a desired state, so setting it again changes nothing. (b) Not idempotent, since each call reboots again. Persist a recovery point with a requested-at time. On retry, check for a reboot timestamp newer than that time before reissuing. That shows a reboot happened since then, not necessarily that your call caused it. (c) Not idempotent, according to the rack doc. Persist the returned job ID and poll it. If the outcome is ambiguous or the job is missing, fail closed to `Error` instead of resubmitting. (d) Idempotent if written as "allocation of this IP = m1", an upsert keyed by IP and machine. Not idempotent if written as "allocate the next free IP", which would grab a new IP on every retry.

</details>

### Explain it

In your own words: NICo already records progress durably. Why does it still require external effects to be safe to retry?

### Check

**1. Does NICo's state-controller framework guarantee exactly-once execution of handlers?**

A. No; handlers and external effects must be safe to retry
B. Yes, through the queue claim
C. Yes, but only for Transition outcomes
D. Yes, because Temporal wraps every handler

<details>
<summary>Answer</summary>

**A.** No; handlers and external effects must be safe to retry

The state-handling page says the framework doesn't guarantee exactly-once execution, and that the queue claim coordinates dispatch but doesn't fence writes or effects. Core state controllers are not Temporal workflows.

</details>

**2. In ConfigureNmxCluster, RMS can no longer find the persisted ScaleUpFabricManager V2 job. What does NICo do, and why?**

A. Resubmits it, because the V2 request is an idempotent desired state
B. Moves to Error, because every RMS job is non-idempotent
C. Waits forever for the job to reappear
D. Rolls back the certificate batch

<details>
<summary>Answer</summary>

**A.** Resubmits it, because the V2 request is an idempotent desired state

The rack doc treats V2 as idempotent, so resubmitting is safe. Going to Error is the response for the non-idempotent certificate batch. There's no such thing as a rollback of external work.

</details>

**3. A previous attempt's outcome is unknown, and there is no safe way to repeat or compensate. What should the handler do?**

A. Fail closed: keep the recovery point, don't advance, record an actionable error
B. Retry until it succeeds
C. Assume it succeeded and transition
D. Delete the recovery point and start fresh

<details>
<summary>Answer</summary>

**A.** Fail closed: keep the recovery point, don't advance, record an actionable error

Blind retries or assuming success can double an effect or hide a failure. Deleting the recovery point throws away the evidence needed to reconcile.

</details>

**Sources:** [architecture/state_handling.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_handling.md), [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md)

<a id="optimistic-concurrency-stale-write-protection"></a>
## 6. Optimistic concurrency / stale-write protection

*Builds on: Database transaction (ch. 4)*

### Before you read

- Two workers each read machine m1 at version 7. Worker A writes state "Rebooting" and version 8. Then worker B, still working from its version-7 view, writes "Ready". What went wrong?
- Does a stale-write rejection mean the system is broken?

<details>
<summary>Answers</summary>

- **Two workers each read machine m1 at version 7. Worker A writes state "Rebooting" and version 8. Then worker B, still working from its version-7 view, writes "Ready". What went wrong?** B overwrote A's newer change based on stale data, which is called a lost update. A version check on write (`WHERE version = 7`) would make B's update match zero rows and be rejected.
- **Does a stale-write rejection mean the system is broken?** No. In NICo it's a normal event. The iteration is invalidated, logged at info level and requeued, so it runs again on fresh state.

</details>

### Explanation

**Optimistic concurrency** assumes conflicts are rare. You don't lock a row while you work. Instead you read it along with a **version**, do your work, and write back only if the stored version still matches the one you read. The guard sits in the UPDATE itself:

```sql
UPDATE machines SET state = 'Ready', version = 8
WHERE id = 'm1' AND version = 7;
```

If someone else committed in between, the version is no longer 7. The statement matches **zero rows**, and your **stale write** is rejected. The affected row count tells you which case happened. The alternative, pessimistic locking, holds a lock from read to write, which conflicts with keeping transactions short.

**In NICo:** the processor passes `old_version` and `new_version` to `persist_controller_state`, but these values **don't enforce anything by themselves**. Each `StateControllerIO` implementation has to apply its own guard. The common guard is an optimistic version predicate. Others include owner or claim predicates and transactionally locked rereads. The machine controller's write updates the host only when its controller-state version still matches. The SPDM controller guards the attestation device's version. On a version mismatch or a missing row, the write returns `ConditionalWrite::NotApplied(ControllerStateNotCurrent)`.

What happens next:

1. The iteration is **invalidated**. The processor rolls back the whole transaction, *including handler-owned writes*, and persists no state, history or outcome from that iteration.
2. This is **not an operational failure**. It's logged at info level, and an immediate requeue is scheduled.
3. A **new pass loads fresh state**. NICo doesn't retry the rejected write against the old snapshot, because decisions made on stale data may be wrong.

The same idea appears in NICo's **key group synchronization design** for NICo REST. That doc describes key groups as versioned, with the version changing to a new unique value on every edit. The REST API *could* expose that version to users, though it doesn't have to. If it does, it can offer update APIs with a version precondition, so a change fails when another admin has edited the group concurrently. The doc's prose calls this `ifVersionNotMatch` semantics; its sequence diagram shows an `ifVersionMatch` parameter. The design also uses versions to tell whether each site has the latest copy of a group.

**Analogy.** Editing a shared wiki page works like this. When you hit save, the wiki checks that the page hasn't changed since you opened it. If it has, the wiki refuses and makes you reload. Where it breaks down: a wiki usually shows you a merge screen. NICo doesn't merge. It throws the whole iteration away and decides again from fresh state.

### Worked example: Watch a stale write get rejected in SQLite

**Step 1: Set up a versioned row.**

```python
# occ_demo.py
import sqlite3

conn = sqlite3.connect(":memory:")
conn.execute("CREATE TABLE machines(id TEXT PRIMARY KEY, state TEXT, version INTEGER)")
conn.execute("INSERT INTO machines VALUES ('m1', 'Discovered', 7)")
conn.commit()
```

**Step 2: Both workers read the same version.**

```python
read_a = conn.execute("SELECT version FROM machines WHERE id='m1'").fetchone()[0]
read_b = conn.execute("SELECT version FROM machines WHERE id='m1'").fetchone()[0]
```
Both get `7`.

**Step 3: Write with a version predicate.**

```python
def write(state, old):
    with conn:
        cur = conn.execute(
            "UPDATE machines SET state=?, version=? WHERE id='m1' AND version=?",
            (state, old + 1, old),
        )
    return cur.rowcount == 1

print("A applied:", write("Rebooting", read_a))  # True
print("B applied:", write("Ready", read_b))      # False: stale
print(conn.execute("SELECT * FROM machines").fetchall())
```
The output ends with `[('m1', 'Rebooting', 8)]`: A's update survived.

**Step 4: React like NICo does.**

B shouldn't blindly retry with `write("Ready", 8)`. It should treat the result as "iteration invalidated": throw away its decision, reload (now version 8, state Rebooting), and run its logic again. In NICo the rejection also rolls back any other writes B queued in the same transaction.

### Your turn: finish it

Complete this guarded write so that it applies only if the stored version still equals `old_version`, and reports whether it applied.

```text
def persist_state(conn, machine_id, new_state, old_version):
    with conn:
        cur = conn.execute(
            "UPDATE machines SET state = ?, version = ? WHERE id = ? AND ___",
            (new_state, old_version + 1, machine_id, old_version),
        )
    return ___
```

<details>
<summary>Answer</summary>

First blank: `version = ?`, which binds to `old_version`. Second blank: `cur.rowcount == 1`. A missing row also gives 0 rows, and NICo treats that as not applied too.

</details>

### Your turn: on your own

This is a hypothetical based on the key group sync design. Suppose NICo REST exposes key group versions and offers a version-match precondition on updates, which the design allows but doesn't require. Tenant admins Ana and Ben both open key group "MyKeys" at version `V2-T1666644937952400`. Ana adds Key3 and saves with the precondition "version must be `V2-T1666644937952400`". Ben then removes Key1 and saves with the same precondition. What happens to each save, and what should Ben's UI do? Then name the matching outcome inside a NICo state controller.

<details>
<summary>Hint 1</summary>

Under the design, Ana's save changes the version. To what, roughly?

</details>

<details>
<summary>Hint 2</summary>

Ben's precondition names a version that no longer exists.

</details>

<details>
<summary>Hint 3</summary>

In a controller this is "iteration invalidated". What gets rolled back, and what runs next?

</details>

<details>
<summary>Answer</summary>

Ana's precondition matches, so her save succeeds and the group gets a new unique version (for example `V3-T…`). Ben's save fails because the stored version no longer matches his precondition. His UI should reload the group (which now has Key3), show him the current state and let him redo the removal. It should not silently overwrite Ana's change. Without such a precondition, Ben's full overwrite would quietly erase Key3, which is exactly what the design's optional precondition is meant to prevent. In a state controller, the matching outcome is that the persistence call returns `NotApplied(ControllerStateNotCurrent)`. The processor rolls back the whole iteration, including handler-owned writes, logs it at info level and requeues immediately so the handler runs again on fresh state.

</details>

### Explain it

In your own words: When a write is rejected as stale, why does NICo throw away the iteration and reload, instead of just retrying the same write with the new version number?

### Check

**1. The processor passes `old_version` to `persist_controller_state`, but the implementation ignores it and reports success. What happens?**

A. The processor cannot detect the stale write; protection depends on the implementation
B. The processor rejects the write anyway
C. PostgreSQL detects the conflict automatically
D. Temporal retries the write

<details>
<summary>Answer</summary>

**A.** The processor cannot detect the stale write; protection depends on the implementation

The state-handling page warns about exactly this. The version values don't enforce anything by themselves, so check the concrete implementation before relying on stale-write rejection.

</details>

**2. How does NICo treat an invalidated iteration?**

A. As a normal event: info-level log, rollback, immediate requeue
B. As an operational error with a persisted error outcome
C. As a reason to move the resource to Error state
D. It retries the same write against the old snapshot

<details>
<summary>Answer</summary>

**A.** As a normal event: info-level log, rollback, immediate requeue

Invalidation isn't an operational failure, so no error outcome is persisted. `CheckApplied` doesn't retry against the old snapshot; a fresh pass reloads state.

</details>

**3. A guarded `UPDATE … WHERE id = ? AND version = ?` affects 0 rows. Which of these could be the cause?**

A. Another writer changed the version, or the row no longer exists
B. The transaction committed twice
C. The UPDATE succeeded but the driver hid it
D. The database is out of disk

<details>
<summary>Answer</summary>

**A.** Another writer changed the version, or the row no longer exists

NICo treats both cases, a missing target or a version mismatch, as `NotApplied`. A full disk raises an error; it doesn't produce a clean 0-row result.

</details>

**Sources:** [architecture/state_handling.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_handling.md), [architecture/key_group_sync.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/key_group_sync.md)

<a id="worklock-lease-and-fencing"></a>
## 7. WorkLock lease and fencing

*Builds on: Database transaction (ch. 4)*

### Before you read

- A worker holds a 30-second lock and then freezes for 60 seconds, say because of a long GC pause or a VM migration. Another worker takes the lock. The first worker wakes up still "holding" its lock object. Is it safe for it to write?
- Is "my lease should still be valid because only 10 seconds have passed" good evidence of ownership?

<details>
<summary>Answers</summary>

- **A worker holds a 30-second lock and then freezes for 60 seconds, say because of a long GC pause or a VM migration. Another worker takes the lock. The first worker wakes up still "holding" its lock object. Is it safe for it to write?** No. It lost ownership while frozen. It must prove it still owns the lease inside the same transaction as its write (a fence), and that check will fail.
- **Is "my lease should still be valid because only 10 seconds have passed" good evidence of ownership?** No. NICo's docs say not to use elapsed time as proof of ownership or of loss. Only the fence check against the database counts as evidence.

</details>

### Explanation

Some work runs longer than one short transaction and must not be done by two workers at once. A **lease** is a lock with an expiry: a database row saying "worker W owns key K until time E". If W dies, the lease eventually expires and someone else can take over, so nothing stays stuck forever. To keep a lease while it is still working, the owner **renews** it periodically (a keepalive).

The danger is that a lease can be lost *while the old owner keeps running*. Its process pauses, renewal fails, another worker takes over, and the old owner wakes up believing it's still in charge. A worker in this state is often called a zombie. **Fencing** stops it: every protected write must prove ownership at write time, inside the same transaction.

**In NICo:** the work-lock manager hands out a `WorkLock`. It's an expiring lease with a background task that tries to renew it automatically. The rules:

- Holding the Rust `WorkLock` value in scope is **not** proof of ownership.
- Before protected writes, call **`WorkLock::fence_transaction`** and do those writes **in the same short transaction**. Treat any fencing error, even a database query failure, as a failed fence, and roll back or discard the transaction.
- Retry protected writes only in a **new** transaction, after `fence_transaction` succeeds there.
- `fence_transaction` does **not** renew the lease. Nominal expiry alone doesn't prove loss either. If no takeover has changed the worker ID, the fence can still succeed, and a later takeover waits behind your transaction (it is serialised). If the worker ID *has* changed, acquire a new `WorkLock` before doing protected work.
- Fencing is **opt-in** and works per key. It can't stop a transaction that skips the fence or uses a different key.
- **External effects** aren't covered. They need their own protections: external fencing or compare-and-set, safe repetition, serialisation and reconciliation.

Don't confuse a WorkLock with the state controller's **queue claim**. The queue claim coordinates dispatch: another processor can reclaim a row once its `processing_started_at` is older than 3× the configured timeout. It does not fence lifecycle writes. Neither mechanism gives exactly-once execution.

**Analogy.** Think of a hotel key card with a checkout time. The card opens the door until the front desk re-issues the room. A fence is the door checking with the desk *at the moment you swipe*, not when you were handed the card. Where it breaks down: a hotel door physically blocks you. Database fencing only works if every protected write actually swipes, because the fence is opt-in.

### Worked example: Build a toy lease and fence in SQLite (not NICo's schema)

**Step 1: Create the lock table.**

```python
# lease_demo.py
import sqlite3, time

db = sqlite3.connect("lease.db", isolation_level=None, timeout=10)
db.executescript("""
DROP TABLE IF EXISTS work_locks; DROP TABLE IF EXISTS machines;
CREATE TABLE work_locks(key TEXT PRIMARY KEY, worker_id TEXT NOT NULL, expires_at REAL NOT NULL);
CREATE TABLE machines(id TEXT PRIMARY KEY, state TEXT NOT NULL);
INSERT INTO machines VALUES ('m1', 'NeedsReboot');
""")
```
`isolation_level=None` lets us write `BEGIN IMMEDIATE` and `COMMIT` ourselves. `BEGIN IMMEDIATE` takes SQLite's write lock, which serialises our transactions.

**Step 2: Acquire: take over only if expired.**

```python
def acquire(key, worker, ttl):
    now = time.time()
    db.execute("BEGIN IMMEDIATE")
    db.execute(
        "INSERT INTO work_locks VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET worker_id=excluded.worker_id, expires_at=excluded.expires_at "
        "WHERE work_locks.expires_at < ?",
        (key, worker, now + ttl, now),
    )
    owner = db.execute("SELECT worker_id FROM work_locks WHERE key=?", (key,)).fetchone()[0]
    db.execute("COMMIT")
    return owner == worker
```

**Step 3: Fence: prove ownership inside the write transaction.**

```python
def fenced_write(key, worker, machine, state):
    db.execute("BEGIN IMMEDIATE")
    try:
        row = db.execute(
            "SELECT 1 FROM work_locks WHERE key=? AND worker_id=?", (key, worker)
        ).fetchone()
        if row is None:
            raise RuntimeError("fence failed")
        db.execute("UPDATE machines SET state=? WHERE id=?", (state, machine))
        db.execute("COMMIT")
        return True
    except Exception:
        db.execute("ROLLBACK")
        return False
```
The fence checks the **worker ID**, not the clock. That matches NICo's rule against reasoning from elapsed time.

**Step 4: Simulate a zombie worker.**

```python
print(acquire("machine:m1", "A", ttl=1))           # True
time.sleep(1.5)                                     # A freezes; lease expires
print(acquire("machine:m1", "B", ttl=30))          # True: takeover
print(fenced_write("machine:m1", "B", "m1", "Ready"))     # True
print(fenced_write("machine:m1", "A", "m1", "NeedsReboot")) # False: zombie fenced out
print(db.execute("SELECT * FROM machines").fetchall())   # [('m1', 'Ready')]
```
Run `python3 lease_demo.py`. You should see `True`, `True`, `True`, `False`, `[('m1', 'Ready')]`.

**Step 5: Try the edge case NICo calls out.**

Now delete the `acquire("machine:m1", "B", ttl=30)` line and run the script again. Without the takeover, the expected output changes to:
```text
True
False
True
[('m1', 'NeedsReboot')]
```
Here's why each line changed. B never acquired the lease, so **B's** fenced write now fails: the row still names A. A's lease is nominally expired, but nobody took over, so **A's** fence still **succeeds** and its `NeedsReboot` write commits. This matches the docs: expiry alone doesn't prove loss, and a later takeover would simply wait behind A's transaction. (If you'd rather isolate the edge case, delete both of B's lines. You'll then see `True`, `True`, `[('m1', 'NeedsReboot')]`.)

### Your turn: finish it

Complete the fence inside this write transaction so that the UPDATE only commits if `worker` still owns `key`. Any fence problem must roll back.

```text
def protected_update(db, key, worker, machine_id):
    db.execute("BEGIN IMMEDIATE")
    try:
        owned = db.execute(
            "SELECT 1 FROM work_locks WHERE ___",
            (key, worker),
        ).fetchone()
        if owned is None:
            raise RuntimeError("fence failed")
        db.execute("UPDATE machines SET state='Ready' WHERE id=?", (machine_id,))
        db.execute("COMMIT")
    except Exception:
        db.execute("___")
        raise
```

<details>
<summary>Answer</summary>

First blank: `key = ? AND worker_id = ?`. Second blank: `ROLLBACK`. The check and the write share one transaction. Doing the fence in a separate, earlier transaction would reopen the race.

</details>

### Your turn: on your own

Worker A holds the WorkLock for `machine:m7`. It sends a Redfish reset to m7's BMC, then pauses for 2 minutes. Meanwhile its keepalive fails and worker B acquires the lock. A wakes up and wants to (1) write `state = Rebooted` to the database and (2) send a second Redfish call to change the boot order. What happens to each, and what should A do?

<details>
<summary>Hint 1</summary>

Where does `fence_transaction` run, and what does it compare?

</details>

<details>
<summary>Hint 2</summary>

Does a database fence stop an HTTP call to a BMC?

</details>

<details>
<summary>Hint 3</summary>

After losing ownership, what must A do before mutating anything external?

</details>

<details>
<summary>Answer</summary>

(1) A's `fence_transaction` sees that the worker ID has changed to B and fails. A must roll back or discard the transaction, so the write never commits. (2) The database fence does nothing to stop A's Redfish call. If A sends it anyway, it's an unprotected change that may conflict with B's work. A must stop changing things and do read-only discovery at most. Before any protected work, it has to acquire a new WorkLock, which only succeeds after B releases it or B's lease expires. The boot-order call itself should be safe to repeat (a desired-state call) and reconciled, or protected by external fencing or compare-and-set. Separately, the first reset A sent is now an ambiguous effect that the current owner has to reconcile.

</details>

### Explain it

In your own words: Why must the fence check happen in the same transaction as the protected write, rather than once at the start of the work?

### Check

**1. Does `WorkLock::fence_transaction` renew the lease?**

A. No; a background task handles renewal, and the fence only proves ownership for that transaction
B. Yes, every call extends the expiry
C. Yes, but only if the lease has expired
D. Only when called outside a transaction

<details>
<summary>Answer</summary>

**A.** No; a background task handles renewal, and the fence only proves ownership for that transaction

The docs say `WorkLock` starts a background renewal task and that `fence_transaction` doesn't renew. Treating the fence as a heartbeat is a common misconception.

</details>

**2. A transaction writes to rows protected by `machine:m1` but never calls `fence_transaction`. What protects it?**

A. Nothing; fencing is opt-in and can't stop a transaction that omits it
B. The work-lock manager blocks it automatically
C. PostgreSQL rejects it
D. The queue claim fences it

<details>
<summary>Answer</summary>

**A.** Nothing; fencing is opt-in and can't stop a transaction that omits it

The docs say the mechanism can't stop a transaction that omits the fence or uses another key. The queue claim coordinates dispatch but doesn't fence lifecycle writes.

</details>

**3. A worker's lease nominally expired 5 seconds ago, but no other worker has taken over. What does `fence_transaction` do?**

A. It can still succeed, and a later takeover is serialised behind the transaction
B. It always fails once the expiry time has passed
C. It renews the lease and succeeds
D. It deletes the lease

<details>
<summary>Answer</summary>

**A.** It can still succeed, and a later takeover is serialised behind the transaction

Nominal expiry doesn't prove ownership loss; only a changed worker ID does. That's why elapsed time isn't evidence either way.

</details>

**Sources:** [architecture/state_handling.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_handling.md)

<a id="build-task"></a>
## Build task: Mini state controller: survive crashes, races and rate limits

**Goal:** Build a tiny state controller in Python and SQLite that moves 12 fake machines from `NeedsReboot` to `Ready` by calling a fake BMC microservice. The fake BMC is rate-limited with GCRA. Every machine must be rebooted exactly once, even when you crash the worker mid-operation and when two workers race each other.

**Why it matters for NICo:** This is a miniature of what NICo's state controllers must do. Short transactions, a durable recovery point before the external call, a stable idempotency key, a version-guarded state write, and a lease plus fence together keep the database consistent and stop hardware from being rebooted twice. The fake BMC's 429 responses mirror the DPU agent's GCRA limiter, and running it as a separate service shows why every hop needs retries.

**You need:**

- Linux or macOS with Python 3.9+ (standard library only: sqlite3, http.server, urllib, fractions)
- curl
- A working directory, e.g. `mkdir ~/mini-controller && cd ~/mini-controller`
- Optional for the stretch goal: the Temporal CLI (`brew install temporal`, or `curl -sSf https://temporal.download/cli.sh | sh`)

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Create the database</summary>

```python
# init_db.py
import sqlite3

c = sqlite3.connect("lab.db")
c.executescript("""
DROP TABLE IF EXISTS machines; DROP TABLE IF EXISTS work_locks; DROP TABLE IF EXISTS ops;
CREATE TABLE machines(id TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL);
CREATE TABLE work_locks(key TEXT PRIMARY KEY, worker_id TEXT NOT NULL, expires_at REAL NOT NULL);
CREATE TABLE ops(op_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, status TEXT NOT NULL);
""")
c.executemany("INSERT INTO machines VALUES (?, 'NeedsReboot', 1)", [(f"m{i}",) for i in range(12)])
c.commit()
```
Run `rm -f bmc_effects.log && python3 init_db.py`.

</details>

<details>
<summary>Step 2: Run the fake BMC microservice</summary>

The fake BMC rate-limits with GCRA (3/s, burst 8) and honours an idempotency key (`op_id`). Every *real* effect is appended to `bmc_effects.log`. Every request, including replays and rejections, is also printed to stdout as `<op_id> <status code> <replayed>`, so you can watch what happens.
```python
# bmc.py
import json, threading, time
from fractions import Fraction
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RATE, BURST = 3, 8
T = Fraction(1, RATE)
TAU = (BURST - 1) * T
state = {"tat": Fraction(0), "seen": {}}
lock = threading.Lock()

try:
    with open("bmc_effects.log") as f:
        state["seen"] = {line.strip(): True for line in f if line.strip()}
except FileNotFoundError:
    pass

def gcra_allow(now):
    tat = max(state["tat"], now)
    if tat - now > TAU:
        return False
    state["tat"] = tat + T
    return True

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers["Content-Length"])
        op_id = json.loads(self.rfile.read(length))["op_id"]
        with lock:
            if op_id in state["seen"]:
                code, result = 200, {"op_id": op_id, "replayed": True}
            elif not gcra_allow(Fraction(time.monotonic())):
                code, result = 429, {"error": "rate limited"}
            else:
                with open("bmc_effects.log", "a") as f:
                    f.write(op_id + "\n")
                state["seen"][op_id] = True
                code, result = 200, {"op_id": op_id, "replayed": False}
        print(op_id, code, result.get("replayed"), flush=True)
        data = json.dumps(result).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

ThreadingHTTPServer(("127.0.0.1", 8081), Handler).serve_forever()
```
Start it with `python3 bmc.py` in its own terminal and leave it running. Lines like `test-1 200 False` go to stdout; Python's own request log (`"POST /reset HTTP/1.1" 200 -`) goes to stderr. Test it:
```bash
curl -s -X POST -d '{"op_id":"test-1"}' http://127.0.0.1:8081/reset; echo
curl -s -X POST -d '{"op_id":"test-1"}' http://127.0.0.1:8081/reset; echo   # replayed: true
for i in $(seq 1 12); do curl -s -o /dev/null -w '%{http_code} ' -X POST -d "{\"op_id\":\"b$i\"}" http://127.0.0.1:8081/reset; done; echo
```
In the BMC terminal you should see `test-1 200 False` and then `test-1 200 True`. The loop should print several `200`s followed by `429`s. When you're done testing, stop the BMC (Ctrl-C), run `rm -f bmc_effects.log` and start it again, so the test IDs don't pollute your results.

</details>

<details>
<summary>Step 3: Write lease helpers</summary>

In `worker.py`, open the database with `sqlite3.connect("lab.db", isolation_level=None, timeout=10)`. Copy `acquire(key, worker, ttl)` from the WorkLock lesson's worked example (`BEGIN IMMEDIATE` plus an upsert that only takes over an expired lease). Use the key `machine:<id>` and a TTL of 3 seconds. Write the fence yourself: inside a `BEGIN IMMEDIATE` transaction, run `SELECT 1 FROM work_locks WHERE key=? AND worker_id=?` and raise if no row comes back. Give each worker a unique ID, e.g. `f"{socket.gethostname()}-{os.getpid()}"`.

</details>

<details>
<summary>Step 4: Write the controller loop in the right order</summary>

Each pass reads `SELECT id FROM machines WHERE state='NeedsReboot' ORDER BY rowid`, so machines are processed in order m0, m1, … For each machine:
1. **Lease:** call `acquire`. If you don't get the lease, skip the machine for now.
2. **Load (short txn, commit):** read `state, version`. If the state isn't `NeedsReboot`, skip.
3. **Recovery point (short txn, commit):** set `op_id = f"{mid}-reboot-v{version}"`, then run `INSERT OR IGNORE INTO ops VALUES (?, ?, 'pending')`.
4. **External call (no txn open):** POST `{"op_id": op_id}` to `http://127.0.0.1:8081/reset` with `urllib.request`, and print the JSON reply (e.g. `m0 -> {'op_id': 'm0-reboot-v1', 'replayed': False}`). On HTTP 429 (`urllib.error.HTTPError` with `.code == 429`), sleep about 0.4 s and retry with the **same** `op_id`.
5. **Optional pause:** if the env var `PAUSE_AFTER_CALL` is set, call `time.sleep(float(os.environ["PAUSE_AFTER_CALL"]))`.
6. **Optional crash:** if the env var `CRASH_AFTER_CALL` is set, call `os._exit(1)` right here. At this point the BMC has acted but the database doesn't know.
7. **Fenced, versioned write (one txn):** run the fence, then `UPDATE machines SET state='Ready', version=version+1 WHERE id=? AND version=?` and `UPDATE ops SET status='done' WHERE op_id=?`. If the fence fails, `ROLLBACK` and print `fence failed`. If the UPDATE's `rowcount != 1`, `ROLLBACK` and print `stale write rejected`. Otherwise `COMMIT`.

Repeat passes until no machine is left in `NeedsReboot`. Sleep about 0.2 s between passes so a worker waiting for someone else's lease doesn't spin at 100% CPU.

</details>

<details>
<summary>Step 5: Inject a crash</summary>

Keep the same BMC process running for both commands:
```bash
CRASH_AFTER_CALL=1 python3 worker.py   # dies right after the first BMC call (m0)
python3 worker.py                       # waits ~3 s for m0's stale lease, then finishes the job
```
Now look at the BMC terminal's stdout. The first run produced `m0-reboot-v1 200 False`: the reboot really happened, and then the worker died before updating the database. The second run read m0 at version 1 again, built the same `op_id`, and the BMC answered with **`m0-reboot-v1 200 True`**. That line is your proof that the retry was recognised as a replay and caused no second effect. The second worker's own output should show `m0 -> {'op_id': 'm0-reboot-v1', 'replayed': True}`. `grep -c '^m0-reboot-v1$' bmc_effects.log` should print `1`.

</details>

<details>
<summary>Step 6: Force a race</summary>

Reset everything: run `python3 init_db.py`, stop the BMC, run `rm -f bmc_effects.log`, and start the BMC again. Then run two workers at once:
```bash
PAUSE_AFTER_CALL=5 python3 worker.py > slow.out 2>&1 &   # slow worker: its 3 s lease expires mid-pause
sleep 1; python3 worker.py
wait
cat slow.out
```
The fast worker waits out the slow worker's lease on m0, takes it over, gets `m0-reboot-v1 200 True` (a replay) from the BMC, and commits. When the slow worker wakes up, it must print `fence failed` (or `stale write rejected`) and commit nothing for m0.

</details>

**Check it works:** Run these after the race step:
```bash
wc -l < bmc_effects.log                    # expect 12: one real reboot per machine
python3 -c "import sqlite3; print(sqlite3.connect('lab.db').execute('SELECT state, version, COUNT(*) FROM machines GROUP BY 1, 2').fetchall())"
# expect [('Ready', 2, 12)]
grep -E 'fence failed|stale write rejected' slow.out   # expect at least one line
```
These three checks test **your controller**:
- **12 lines in `bmc_effects.log`** means every machine was rebooted exactly once. If your worker built a new `op_id` on retries (a random UUID or a timestamp), the BMC would treat the retries as new requests and you'd see more than 12.
- **`[('Ready', 2, 12)]`** means every machine advanced exactly once. A missing version guard that let a stale write through would show up as a version above 2 or a machine stuck in the wrong state.
- **A `fence failed` or `stale write rejected` line** in the slow worker's output means the zombie was stopped.

You may also see `sort bmc_effects.log | uniq -d | wc -l` printing `0` suggested as a check. It always prints 0, because the BMC drops repeated `op_id`s before logging them. It only confirms the BMC's own deduplication and says nothing about your worker.

<details>
<summary>If you get stuck</summary>

- `sqlite3.OperationalError: database is locked`: pass `timeout=10` to `connect`, and make sure no `BEGIN` is still open while you call the BMC.
- With `isolation_level=None` you control transactions yourself. Every `BEGIN IMMEDIATE` needs a matching `COMMIT` or `ROLLBACK` on every code path, so wrap the body in try/except.
- The BMC's `print` lines go to stdout and Python's request log goes to stderr. If you background the BMC, capture both with `python3 bmc.py > bmc.out 2>&1 &` and read them with `grep reboot bmc.out`.
- If `bmc_effects.log` has 13 or more lines, check that your `op_id` comes from the version you *read*, not from a random UUID or the current time. A retry must reuse the same ID.
- If you never see `200 True` after the crash, check that you didn't restart the BMC with a deleted `bmc_effects.log` between the two runs, and that the second worker reached m0 (it has to wait about 3 s for the dead worker's lease to expire).
- If the slow worker never gets fenced out, its pause must be longer than the lease TTL, and the fast worker must call `acquire` again after the lease has expired. That's why the loop repeats passes.

</details>

**Stretch goal:** Add a background thread that renews the lease every second. Then show that a renewal thread alone doesn't save a paused worker. Python's `time.sleep` doesn't block other threads, so simulate a frozen process with `kill -STOP <pid>`, and later resume it with `kill -CONT <pid>`. Next, start `temporal server start-dev` and create the `cloud`, `site` and a random-UUID namespace with `temporal operator namespace create --namespace <name>`. Port the reboot step into a Temporal activity using the Python SDK (`pip install temporalio`). Kill the worker mid-activity and confirm that the retried activity is still applied only once: the BMC should print `... 200 True` for the retry, and `bmc_effects.log` should gain only one line for it.

## Review notes

The draft was rewritten once using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (Database transaction): The completion problem's `result = ___` blank expects `call_bmc(machine_id, op_id)`, but the prompt never says what arguments `call_bmc` takes. `call_bmc(machine_id)` is an equally plausible fill, so the expected answer is ambiguous. *Fix:* State the callable's signature in the prompt, e.g. "`call_bmc(machine_id, op_id)` sends the reset and returns a status string", or accept any call made outside the `with conn:` block.

---

[← 03-networking-basics.md](03-networking-basics.md) · [05-uefi-firmware-nico-architecture.md →](05-uefi-firmware-nico-architecture.md)
