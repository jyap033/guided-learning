# Chapter 16: Scale & Sizing

*Part: Kubernetes & Deployment · 7 concepts · [curriculum](../curriculum.md#chapter-16)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Chapters 14 and 15 got a NICo site controller running: workloads, Services, storage, Calico and MetalLB. This chapter asks how big a fleet that cluster can carry, and which knobs you turn when it has to carry more. The answers come from NICo's Sizing and Scale Guidance. That page records field data from 33 sites (the largest has 1,930 hosts) and simulated fleets up to 1,112 GB200 NVL72 racks, which is 20,016 hosts and 60,048 machines.

The lessons follow the order in which the scale runs hit each problem. First you'll learn how Kubernetes caps a container's CPU and memory, and why nico-api and the Postgres primary reach their own caps long before their nodes run out of CPU. Then come the tools that work around those caps: pod anti-affinity to keep the two heavy components on different nodes, the right way to read Postgres memory (working set versus `oom_kill`), and Tokio worker threads, so a bigger CPU limit actually gets used.

The second half is about testing at scale without hardware. NICo's fleet simulator, machine-a-tron, publishes every simulated BMC as a Kubernetes Service `externalIP`. With kube-proxy in IPVS mode, that runs into a hard limit of 65,536 ipset entries per node. That's a limit of the simulator, not of NICo, but you need to know it before you plan a large simulated run.

Everything here is about the control plane. You'll apply it in Chapter 42, when you measure fleet-up and time to ready yourself.

**By the end of this chapter you can:**

- Set CPU and memory requests and limits on a pod and confirm them in the container's cgroup files (`cpu.max`, `memory.max`)
- Write a required pod anti-affinity rule that keeps two workloads off the same node, and explain when NICo's large-fleet runs needed one
- Tell normal page-cache growth apart from real memory pressure by reading `memory.stat` and the `oom_kill` counter in `memory.events`
- Expose a Service on a chosen address with `externalIPs`, and work out how many simulated racks fit in kube-proxy's IPVS ipset
- Match an async runtime's worker thread count to its container CPU limit using an environment variable
- Describe what machine-a-tron simulates and what it doesn't, and size the BMC addresses and Service entries a simulated fleet needs

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [Kubernetes resource limits](#kubernetes-resource-limits)
2. [Pod anti-affinity](#pod-anti-affinity)
3. [Kubelet working set and OOM kill](#kubelet-working-set-and-oom-kill)
4. [Kubernetes Service externalIP](#kubernetes-service-externalip)
5. [Tokio worker threads](#tokio-worker-threads)
6. [kube-proxy IPVS mode](#kube-proxy-ipvs-mode)
7. [Machine-a-tron](#machine-a-tron)
8. [Build task: A mini scale lab: fake BMC fleet, anti-affinity, matched threads and OOM signals on kind](#build-task)

<a id="kubernetes-resource-limits"></a>
## 1. Kubernetes resource limits

*Builds on: Kubernetes workload and config objects (ch. 14)*

### Before you read

- A container has a CPU limit of 2 and tries to use 4 CPUs' worth of work. Does Kubernetes kill it, slow it down, or let it run?
- A server has two 24-core sockets with Hyper-Threading on. How many CPUs does Kubernetes say the node has?

<details>
<summary>Answers</summary>

- **A container has a CPU limit of 2 and tries to use 4 CPUs' worth of work. Does Kubernetes kill it, slow it down, or let it run?** It slows it down. The kernel throttles the container to 2 CPUs' worth of time in each scheduling period. Going over the CPU limit gets a container throttled, never killed. Going over the memory limit is what gets a process killed.
- **A server has two 24-core sockets with Hyper-Threading on. How many CPUs does Kubernetes say the node has?** 96. Kubernetes counts logical CPUs (hyper-threads): 2 × 24 × 2 = 96.

</details>

### Explanation

Each container in a pod spec can have a `resources` block with two parts:

- **requests**: what the scheduler sets aside for the container when it picks a node. A pod only lands on a node that still has that much unreserved CPU and memory.
- **limits**: a hard ceiling that the kernel on the node enforces through the container's cgroup (Chapter 2).

**CPU** is measured in **logical CPUs**. A logical CPU is what the OS schedules work on. On a server with Hyper-Threading, each hyper-thread is one logical CPU, so `cpu: "1"` is one hyper-thread, not one physical core. `500m` (millicores) is half a logical CPU. The limit becomes a quota in `cpu.max`: for example, `150000 100000` means 150 ms of CPU time per 100 ms period. A container that uses up its quota is **throttled**. It waits for the next period. It is not killed.

**Memory** is measured in bytes (`Mi`, `Gi`). The limit becomes `memory.max`. If the container goes over it and the kernel can't reclaim enough memory, the kernel's OOM (out-of-memory) killer kills a process in the container.

In NICo you set these per component in the Helm chart values. NICo's sizing page gives these numbers:

- Chart defaults: **nico-api 3 CPUs**, **Postgres primary 8 CPUs and 16 GiB**.
- A baseline site controller node has two 24-core sockets with Hyper-Threading, which is **96 logical CPUs**.
- In field data, nico-api reaches its 3-CPU limit near **1,500 hosts** and the Postgres primary reaches its 8-CPU limit near **2,500 hosts**, while the nodes still have plenty of spare CPU.

So at scale, the first ceiling isn't the hardware. It's the limits written in the chart. A node dashboard can show 70% idle while nico-api is throttled at exactly 3.0 CPUs. For large fleets, the guidance raises the limits: nico-api to 8 CPUs at 250 racks, 32 at 556 racks and 64 at 1,112 racks.

**Analogy.** A CPU limit is like a speed limiter on a rental van. The engine (the node) could go faster, but the van is capped and simply won't go faster. It doesn't crash. A memory limit is more like the van's maximum load: go over it and something gets thrown off. The analogy breaks down because a real speed limiter caps speed all the time. CPU throttling is measured per period, so a container can run at full speed for part of each 100 ms window and then sit idle for the rest.

### Worked example: Set limits on a pod and read them back from the cgroup

**Step 1: Start from a working cluster.**

Use any kind cluster from Chapter 14 (run `kind create cluster` if you don't have one). Check that `kubectl get nodes` shows `Ready`.

**Step 2: Apply a pod with requests and limits.**

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: limits-demo
spec:
  containers:
  - name: demo
    image: busybox:1.36
    command: ["sh", "-c", "sleep 1000000"]
    resources:
      requests:
        cpu: 250m
        memory: 64Mi
      limits:
        cpu: 1500m
        memory: 256Mi
EOF
kubectl wait --for=condition=Ready pod/limits-demo
```

**Step 3: Read the limits the kernel enforces.**

```bash
kubectl exec limits-demo -- cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max
```
Expected output on a cgroup v2 host:
```
150000 100000
268435456
```
1500m becomes 150,000 µs of CPU time per 100,000 µs period. 256Mi becomes 256 × 1024 × 1024 bytes.

**Step 4: Push past the CPU limit and watch the throttling.**

Run two busy loops for 5 seconds. That's 2 CPUs of demand against a 1.5 CPU limit:
```bash
kubectl exec limits-demo -- sh -c 'timeout 5 sh -c "while :; do :; done" & timeout 5 sh -c "while :; do :; done"; wait; cat /sys/fs/cgroup/cpu.stat'
```
`nr_throttled` and `throttled_usec` are now above zero. The container was slowed down, and `kubectl get pod limits-demo` still shows `Running` with 0 restarts.

**Step 5: Clean up.**

`kubectl delete pod limits-demo`

### Your turn: finish it

For the 250-rack measurement, the sizing guidance gives nico-api 8 CPUs. For memory, use 32 GiB, the nico-api memory limit that the 400-rack and 556-rack runs used (the 556-rack row calls it the chart default). Fill in the limits block of this container spec.

```text
    resources:
      requests:
        cpu: "2"
        memory: 8Gi
      limits:
        cpu: ___
        memory: ___
```

<details>
<summary>Answer</summary>

`cpu: "8"` and `memory: 32Gi`. CPU is counted in logical CPUs, so 8 means 8 hyper-threads. Quote it so YAML reads it as a string, which is how Kubernetes manifests usually write quantities. (The 1,112-rack runs went further and gave nico-api 64 GiB.)

</details>

### Your turn: on your own

A container has `limits: {cpu: 2500m, memory: 6Gi}`. What exact values should `/sys/fs/cgroup/cpu.max` and `/sys/fs/cgroup/memory.max` contain inside it? And if the container has 4 CPUs of work to do, what does `kubectl get pod` show?

<details>
<summary>Hint 1</summary>

The default CFS period is 100,000 µs. The quota is the limit times the period.

</details>

<details>
<summary>Hint 2</summary>

1 Gi = 1024³ bytes.

</details>

<details>
<summary>Hint 3</summary>

cpu.max is `250000 100000`. Now multiply 6 × 1,073,741,824, and remember what happens when a container goes over its CPU limit.

</details>

<details>
<summary>Answer</summary>

`cpu.max` is `250000 100000` and `memory.max` is `6442450944`. The pod stays `Running` with no restarts. It is throttled to 2.5 CPUs, which you can see as a rising `nr_throttled` in `cpu.stat`.

</details>

### Explain it

In your own words: Why can nico-api become the bottleneck of a 2,000-host site even when every site controller node shows most of its CPU idle?

### Check

**1. On a node with Hyper-Threading on, what does `cpu: "1"` in a limit mean?**

A. One physical core, both hyper-threads
B. One logical CPU (one hyper-thread)
C. One CPU socket
D. 1% of the node's CPU

<details>
<summary>Answer</summary>

**B.** One logical CPU (one hyper-thread)

Kubernetes counts logical CPUs, which is why a 2×24-core node with HT shows 96. 'One physical core' is the most common mistake, and it would double what you think you're giving the container.

</details>

**2. A container goes over its CPU limit. What happens?**

A. The kernel OOM-kills it
B. Kubernetes evicts the pod to another node
C. The kernel throttles it until the next CFS period
D. Nothing, because limits are only scheduling hints

<details>
<summary>Answer</summary>

**C.** The kernel throttles it until the next CFS period

CPU is compressible: going over means waiting, not dying. OOM kills only happen when a container goes over its memory limit. Limits aren't scheduling hints either. The scheduler uses requests, and the kernel enforces limits.

</details>

**3. According to NICo's field fits, which ceiling is reached first as a site grows from 1,000 hosts at chart defaults?**

A. Node CPU on the busiest controller node
B. The nico-api 3-CPU limit, near 1,500 hosts
C. The Postgres 8-CPU limit, near 1,000 hosts
D. Database disk space

<details>
<summary>Answer</summary>

**B.** The nico-api 3-CPU limit, near 1,500 hosts

The guidance says the component limits are reached before node CPU: nico-api at 3 CPUs near 1,500 hosts, and the Postgres primary at 8 CPUs near 2,500, not 1,000. Disk is explicitly not the scaling constraint.

</details>

**Sources:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

<a id="pod-anti-affinity"></a>
## 2. Pod anti-affinity

*Builds on: Kubernetes workload and config objects (ch. 14)*

### Before you read

- nico-api gets a 64-CPU limit and the Postgres primary gets a 48-CPU limit. Each node has 96 logical CPUs. What could go wrong if the scheduler puts both on one node?
- Guess: is there a way to tell Kubernetes 'never put pod A on a node that already runs pod B'?

<details>
<summary>Answers</summary>

- **nico-api gets a 64-CPU limit and the Postgres primary gets a 48-CPU limit. Each node has 96 logical CPUs. What could go wrong if the scheduler puts both on one node?** 64 + 48 = 112, which is more than 96. If both get busy at the same time, they compete for CPU that isn't there. Keeping them on separate nodes avoids that.
- **Guess: is there a way to tell Kubernetes 'never put pod A on a node that already runs pod B'?** Yes: pod anti-affinity, with `requiredDuringSchedulingIgnoredDuringExecution`.

</details>

### Explanation

By default the scheduler places a pod on any node with enough unreserved requests. **Pod anti-affinity** adds a rule about *other pods*: "don't put me where pods matching this label selector already run."

The rule goes under `spec.affinity.podAntiAffinity`. Each term has three parts:

- **labelSelector**: which pods to avoid, for example `app: postgres-primary`. All the labels and expressions inside one selector must match (they're ANDed together).
- **topologyKey**: what "same place" means. It's a node label. `kubernetes.io/hostname` means the same node. A zone label would mean the same zone.
- **Strength**:
  - `requiredDuringSchedulingIgnoredDuringExecution` is a hard rule. If no node qualifies, the pod stays `Pending`. If you list several required terms, the pod must satisfy every one of them.
  - `preferredDuringSchedulingIgnoredDuringExecution` is a weighted preference that the scheduler drops if it has to.

"IgnoredDuringExecution" means running pods aren't evicted if labels change later. The rule is checked again whenever a pod is (re)scheduled, for example after a node drain.

The scheduler also applies the rule the other way round. If pod A has a required anti-affinity against B and A is already running, B won't be placed on A's node either.

**Why NICo needed it:** the 1,112-rack (20,016-host) simulations gave nico-api 64 CPUs and 64 Tokio worker threads, and the Postgres primary 48 CPUs. Together those two limits come to more than a 96-logical-CPU baseline node, so the runs set a *required* anti-affinity in the nico-api chart values to keep the two on different nodes.

The sizing page shows why placement matters. In the first run, the scheduler put nico-hardware-health on the same node as the Postgres primary, and that node peaked at 63 logical CPUs. In the second run no node carried two of nico-api, Postgres and hardware-health, and the busiest node peaked at 52.

A 20,000-host site has three components that each want a node of their own. That's one reason the guidance recommends 5 nodes, or nodes with more cores, for large GB200-class sites.

**Analogy.** It's like seating rules at a wedding: two guests who will each spread out and take over a whole table must not share one. You write the rule in terms of who they are (labels), not which table (node), so it still holds when the tables change. The analogy breaks down because a seating planner can move guests after the meal starts. Kubernetes only applies the rule when it places a pod and never moves running pods to satisfy it.

### Worked example: Watch a required anti-affinity spread pods or block them

**Step 1: Deploy the 'database'.**

```bash
kubectl create deployment fake-db --image=busybox:1.36 -- sh -c 'sleep 1000000'
kubectl get pod -l app=fake-db -o wide
```
`kubectl create deployment` labels the pods `app=fake-db`.

**Step 2: Deploy an 'API' that refuses to share a node with it.**

```bash
kubectl apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fake-api
spec:
  replicas: 1
  selector:
    matchLabels:
      app: fake-api
  template:
    metadata:
      labels:
        app: fake-api
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: fake-db
            topologyKey: kubernetes.io/hostname
      containers:
      - name: api
        image: busybox:1.36
        command: ["sh", "-c", "sleep 1000000"]
EOF
```

**Step 3: Read the outcome.**

`kubectl get pods -o wide`

- **Single-node kind cluster:** fake-api stays `Pending`. Run `kubectl describe pod -l app=fake-api` and you'll see a `FailedScheduling` event saying the pod didn't match pod anti-affinity rules. The hard rule is doing its job.
- **Multi-worker cluster:** fake-api lands on a different node from fake-db.

**Step 4: Relax it to a preference and compare.**

Change `requiredDuringSchedulingIgnoredDuringExecution` to a preferred term: `- weight: 100`, with the same selector and topologyKey nested under `podAffinityTerm:`. On a single node, the pod now schedules next to fake-db anyway.

**Step 5: Clean up.**

`kubectl delete deployment fake-api fake-db`

### Your turn: finish it

Complete this pod-template fragment so a Postgres primary (pods labelled `role: postgres-primary`) is never scheduled on the same node as nico-api pods (labelled `app: nico-api`).

```text
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: ___
            topologyKey: ___
```

<details>
<summary>Answer</summary>

`app: nico-api` and `topologyKey: kubernetes.io/hostname`. The selector names the pods to avoid, and the hostname label makes 'same place' mean 'same node'. (These labels are made up for the exercise. Check the real labels in your deployment with `kubectl get pods --show-labels`.)

</details>

### Your turn: on your own

Three 96-CPU nodes (A, B, C) run three heavy components: `app: nico-api` on A, `role: postgres-primary` on B, and `app: hardware-health` on C. Write the required anti-affinity rule (one or more terms) for the hardware-health pod that keeps it off any node running either of the other two. Then node C is drained for maintenance (`kubectl drain`). What happens to hardware-health, and when does it run again?

<details>
<summary>Hint 1</summary>

The labels and expressions inside one `labelSelector` are ANDed. A single selector asking for `app=nico-api` and `role=postgres-primary` would only match a pod that has both labels, and no pod does.

</details>

<details>
<summary>Hint 2</summary>

So you need one term per selector. Every term in a required list must be satisfied, which here means 'avoid nico-api nodes' and 'avoid Postgres nodes'.

</details>

<details>
<summary>Hint 3</summary>

A drain evicts the pod, so the replacement has to be scheduled again and the rule applies. Which of A and B can it use?

</details>

<details>
<summary>Answer</summary>

```yaml
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchLabels:
          app: nico-api
      topologyKey: kubernetes.io/hostname
    - labelSelector:
        matchLabels:
          role: postgres-primary
      topologyKey: kubernetes.io/hostname
```
When C is drained, the hardware-health pod is evicted. 'IgnoredDuringExecution' doesn't protect it, because a drain removes the pod. The replacement pod can't go on A (nico-api) or B (Postgres), so it stays `Pending` until C is uncordoned or a new node joins. With three heavy components on three nodes, any one node going out of service leaves a component with nowhere to go. That's part of why the guidance suggests 5 nodes for very large sites.

</details>

### Explain it

In your own words: The 1,112-rack runs used a *required* anti-affinity rather than a *preferred* one. Explain why a preference wouldn't have been enough to protect those runs.

### Check

**1. What does `topologyKey: kubernetes.io/hostname` do in an anti-affinity term?**

A. Picks the node the pod must run on
B. Defines 'same place' as 'same node' when checking for matching pods
C. Makes the pod use the node's hostname as its DNS name
D. Restricts the rule to pods in the same namespace

<details>
<summary>Answer</summary>

**B.** Defines 'same place' as 'same node' when checking for matching pods

The topology key is a node label that groups nodes into domains. With hostname, each node is its own domain. It doesn't pin the pod to a particular node. That's what nodeSelector or node affinity do.

</details>

**2. No node can satisfy a required anti-affinity. What happens?**

A. The scheduler ignores the rule and places the pod
B. The pod stays Pending
C. The conflicting pod is evicted
D. The pod is placed on the control-plane node

<details>
<summary>Answer</summary>

**B.** The pod stays Pending

'Required' is a hard filter. Ignoring the rule when needed is what 'preferred' does. Kubernetes doesn't evict existing pods to satisfy anti-affinity.

</details>

**3. Why did NICo's 20,016-host simulations keep nico-api and the Postgres primary on different nodes?**

A. Postgres replication requires it
B. Their CPU limits (64 and 48) together exceeded a 96-logical-CPU node
C. nico-api cannot reach Postgres on the same node
D. Kubernetes forbids two pods with more than 32 CPUs on one node

<details>
<summary>Answer</summary>

**B.** Their CPU limits (64 and 48) together exceeded a 96-logical-CPU node

The sizing page gives exactly this reason. The other options are invented: same-node networking works fine, and Kubernetes has no such per-node rule.

</details>

**Sources:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

<a id="kubelet-working-set-and-oom-kill"></a>
## 3. Kubelet working set and OOM kill

*Builds on: Kubernetes resource limits (ch. 16), Linux memory and cgroups (ch. 2)*

### Before you read

- A Postgres pod's memory graph has sat at 15.9 GiB of a 16 GiB limit for days. Does it need more memory?
- Guess: is the file cache that Linux builds when a process reads files counted against the container's memory limit?

<details>
<summary>Answers</summary>

- **A Postgres pod's memory graph has sat at 15.9 GiB of a 16 GiB limit for days. Does it need more memory?** Not necessarily. Much of that is page cache, which the kernel can reclaim. The real signal is the `oom_kill` count in its cgroup going up.
- **Guess: is the file cache that Linux builds when a process reads files counted against the container's memory limit?** Yes. cgroup v2 charges page cache to the cgroup that caused it, so it counts toward `memory.current`. The kernel can reclaim it before it has to kill anything.

</details>

### Explanation

Chapter 2 covered cgroups. This lesson covers how Kubernetes *reports* container memory, and why that report misleads at scale.

The kubelet (the agent on each node) reports a container's memory as its **working set**: roughly the cgroup's memory usage minus the file cache the kernel considers inactive. NICo's sizing page puts it as **resident memory plus active page cache**.

- **Resident (anonymous) memory** is the process's own heap and stack. Without swap, the kernel can't drop it.
- **Page cache** is file data the kernel keeps in RAM after reads and writes. It's charged to the container's cgroup. Under pressure the kernel can reclaim it, starting with the inactive part.

Postgres reads its data files through the page cache, so over a long run its working set **grows toward the memory limit by design**. A working set at the limit just means the cache is full. On its own, that isn't evidence that more memory is needed.

The real signal is in the container's cgroup file `memory.events`:

- `oom` counts the times the cgroup hit its limit and reclaim failed.
- `oom_kill` counts the processes the kernel's OOM killer actually killed.

A **rising `oom_kill`** count is the sign to raise the limit. Kubernetes also records `OOMKilled` as a container's last termination reason.

What NICo's data shows:

- **Field data:** the fitted 7-day peak working set crosses the 16 GiB chart default near 480 hosts, and it sits at the 16 GiB limit on 7 of 33 sites.
- **Simulations:** the 400-rack run and the earlier 556-rack run recorded `oom_kill` 0. The first complete 250-rack run finished at the 16 GiB default.
- **Guidance:** keep the table in `helm-prereqs/values.yaml`, which gives 16 GiB up to 5,000 hosts and 32 GiB beyond that. Raise the limit when `oom_kill` in the Postgres cgroup rises, not when the working set reaches the limit.

**Analogy.** The working set is like a desk covered in papers. Someone working at a big desk spreads out to fill it, and that doesn't mean they need a bigger desk. The real sign is when they have to shred something they were still using (an OOM kill). The analogy breaks down because papers don't tidy themselves away, while the kernel quietly drops inactive cache on its own long before anything is killed.

### Worked example: Make page cache fill a limit harmlessly, then trigger real OOM kills

**Step 1: Fill a 128 MiB container with page cache.**

Write a 400 MiB file to the container's disk-backed `/tmp` under a 128 MiB limit. Setting `--memory-swap` equal to `--memory` disables swap:
```bash
docker run --rm --memory 128m --memory-swap 128m debian:stable-slim sh -c '
dd if=/dev/zero of=/tmp/big bs=1M count=400 status=none
echo "memory.current: $(cat /sys/fs/cgroup/memory.current)"
grep -E "^(anon|active_file|inactive_file) " /sys/fs/cgroup/memory.stat
grep -E "^oom_kill " /sys/fs/cgroup/memory.events'
```

**Step 2: Read the result.**

`memory.current` is usually tens of MiB and can approach the 128 MiB limit. Most of it shows up as `active_file`/`inactive_file`, `anon` is tiny, and you see `oom_kill 0`. The exact numbers vary between kernels. The container wrote three times its limit and nothing died, because the kernel reclaimed cache as it went. A dashboard showing the working set here could look 'full'.

**Step 3: Now push anonymous memory over the limit.**

A shell runs a Python child three times. Each time, the child tries to hold 200 MiB of real data:
```bash
docker run --rm --memory 64m --memory-swap 64m python:3.12-slim sh -c '
for i in 1 2 3; do
  python3 -c "x = b\"x\" * (200*1024*1024)"
  echo "attempt $i exit=$?"
done
grep -E "^oom_kill " /sys/fs/cgroup/memory.events'
```

**Step 4: Read the counter.**

Expected:
```
attempt 1 exit=137
attempt 2 exit=137
attempt 3 exit=137
oom_kill 3
```
Exit code 137 is 128 + 9 (SIGKILL). The shell (PID 1) survived, and the counter went up once per kill. This rising count is the signal the sizing guidance tells you to watch.

**Step 5: Map it to Kubernetes.**

In a pod, read the same file with `kubectl exec <pod> -- cat /sys/fs/cgroup/memory.events`, and check `kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}'` for `OOMKilled`. Recent kubelets on cgroup v2 kill the whole container on OOM, so expect restarts as well.

### Your turn: finish it

The kubelet usually computes the working set as usage minus inactive file cache. Fill in the blank so this one-liner prints a container's working set in MiB from inside the container.

```text
cur=$(cat /sys/fs/cgroup/memory.current)
inact=$(awk '$1=="___" {print $2}' /sys/fs/cgroup/memory.stat)
echo $(( (cur - inact) / 1024 / 1024 )) MiB
```

<details>
<summary>Answer</summary>

`inactive_file`. It's the reclaimable cache the kernel considers inactive. Subtract it from `memory.current` and what's left is resident memory plus active cache.

</details>

### Your turn: on your own

You run a 3,000-host site. Postgres has a 16 GiB limit and its working set has been at 15.8 GiB for a week. `memory.events` shows `oom_kill 0` today and `oom_kill 0` a week ago. The same pod has been primary the whole time. Do you raise the limit now? What would change your answer?

<details>
<summary>Hint 1</summary>

What is most of that 15.8 GiB likely to be?

</details>

<details>
<summary>Hint 2</summary>

Which counter does the guidance say to watch, and has it moved?

</details>

<details>
<summary>Hint 3</summary>

Also compare against the `helm-prereqs/values.yaml` table for 3,000 hosts.

</details>

<details>
<summary>Answer</summary>

No. A working set at the limit with `oom_kill` flat at 0 is page cache doing its job, and at 3,000 hosts the values table still says 16 GiB (it covers up to 5,000 hosts). Raise the limit if `oom_kill` starts rising, if `OOMKilled` restarts appear, or if the site grows past 5,000 hosts, where the table says 32 GiB.

</details>

### Explain it

In your own words: Why does a Postgres working set naturally creep up to its memory limit over days, and why does that make 'working set at the limit' a poor alert?

### Check

**1. Which observation is NICo's stated signal to raise the Postgres memory limit?**

A. The kubelet working set reaches the limit
B. A rising oom_kill count in the Postgres container's cgroup
C. Node memory above 80%
D. Postgres database size above 10 GiB

<details>
<summary>Answer</summary>

**B.** A rising oom_kill count in the Postgres container's cgroup

The working set grows toward the limit by design because it includes active page cache. Node memory and database size aren't the signal the guidance names.

</details>

**2. According to the sizing page, what does the kubelet working set include?**

A. Only the process heap
B. Resident memory plus active page cache
C. Resident memory plus swap
D. All memory on the node

<details>
<summary>Answer</summary>

**B.** Resident memory plus active page cache

That's why it keeps growing as Postgres reads data. Heap alone would leave out the cache. Swap isn't part of it, and the figure is per container, not per node.

</details>

**3. A process inside a container is OOM-killed. What exit code does its parent usually see?**

A. 1
B. 137
C. 143
D. 255

<details>
<summary>Answer</summary>

**B.** 137

137 = 128 + 9 (SIGKILL), and SIGKILL is what the OOM killer sends. 143 is 128 + 15 (SIGTERM), a polite shutdown.

</details>

**Sources:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

<a id="kubernetes-service-externalip"></a>
## 4. Kubernetes Service externalIP

*Builds on: Kubernetes Service types (LoadBalancer, NodePort, ClusterIP) (ch. 14)*

### Before you read

- You need 70 Services, each answering on its own fixed, made-up address (10.250.0.1, 10.250.0.2, …), and you don't want a load balancer controller picking the addresses. Which Service feature might do that?
- Guess: if you put 10.250.0.5 in a Service's externalIPs, does Kubernetes announce that address to your network (ARP or BGP) the way MetalLB does?

<details>
<summary>Answers</summary>

- **You need 70 Services, each answering on its own fixed, made-up address (10.250.0.1, 10.250.0.2, …), and you don't want a load balancer controller picking the addresses. Which Service feature might do that?** `spec.externalIPs`: you list the address yourself, and kube-proxy accepts traffic for it on every node.
- **Guess: if you put 10.250.0.5 in a Service's externalIPs, does Kubernetes announce that address to your network (ARP or BGP) the way MetalLB does?** No. Kubernetes only programs the nodes to accept and forward traffic for it. Getting packets to a node is your job.

</details>

### Explanation

Chapter 14 covered ClusterIP, NodePort and LoadBalancer Services. Chapter 15 showed MetalLB allocating LoadBalancer VIPs and announcing them with ARP.

**`spec.externalIPs`** is simpler than any of those. It's a list of addresses *you* choose. On every node, kube-proxy programs rules so that a packet addressed to `<externalIP>:<port>` reaches the Service's endpoints, the same way traffic to its ClusterIP does.

What Kubernetes does **not** do with an externalIP:

- It doesn't allocate it or check it against a pool.
- It doesn't announce it with ARP or BGP.
- It doesn't check that nobody else owns it.

Packets reach it only if something routes them to a node: a static route, a router, or a client that's already inside the cluster. Because anyone who can create Services can claim any address this way, many clusters restrict `externalIPs` with an admission policy. That's worth knowing on a shared cluster.

**Why NICo cares:** machine-a-tron, NICo's fleet simulator, publishes **every simulated BMC and switch NVOS address as a Service `externalIP`**. nico-api's site explorer then probes those addresses as if they were real BMCs on the BMC network. Publishing each pod's Services is part of the definition of **fleet-up**: every simulator pod Ready, the protocol gateway answering, and the controller having published every pod's Services so every simulated BMC address is reachable.

The cost is that a large simulated fleet means tens of thousands of externalIPs, and every node's kube-proxy has to track all of them. The IPVS lesson covers the ceiling that creates.

**Analogy.** An externalIP is like telling your office's front desk: 'any mail addressed to Suite 500, give it to Alice.' The front desk will do that reliably. But nobody told the post office that Suite 500 exists, so mail only arrives if something already brings it to the building. The analogy breaks down because a real post office would reject a made-up suite, while Kubernetes doesn't check that the address belongs to you.

### Worked example: Expose a pod on a made-up address and reach it from inside the cluster

**Step 1: Run a backend.**

```bash
kubectl create deployment web --image=nginx:1.27
kubectl wait --for=condition=Available deployment/web
```

**Step 2: Create a Service with an externalIP.**

Pick a range that doesn't overlap kind's pod range (10.244.0.0/16) or service range (10.96.0.0/12):
```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: web-ext
spec:
  selector:
    app: web
  externalIPs:
  - 10.250.0.10
  ports:
  - port: 80
    targetPort: 80
EOF
kubectl get svc web-ext
```
The `EXTERNAL-IP` column shows `10.250.0.10`. Nothing allocated it: you chose it.

**Step 3: Reach it from a pod.**

```bash
kubectl run curl --rm -i --restart=Never --image=curlimages/curl -- -s -o /dev/null -w '%{http_code}\n' http://10.250.0.10/
```
Prints `200`. The packet left the pod for its node, where kube-proxy's rules matched the externalIP and forwarded it to the nginx pod.

**Step 4: See that nothing announces it.**

From your laptop, `curl --max-time 3 http://10.250.0.10/` times out because your laptop has no route to it. (Optional, Linux only: `sudo ip route add 10.250.0.0/24 via $(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' kind-control-plane)` makes it reachable, which shows that routing is up to you. Remove the route afterwards with `sudo ip route del 10.250.0.0/24`.)

**Step 5: Clean up.**

`kubectl delete svc web-ext; kubectl delete deployment web`

### Your turn: finish it

Complete this Service so a simulated BMC pod (label `app: bmc-sim`, listening on 8443) answers HTTPS on 10.250.1.7, port 443.

```text
apiVersion: v1
kind: Service
metadata:
  name: bmc-7
spec:
  selector:
    app: bmc-sim
  ___:
  - 10.250.1.7
  ports:
  - port: 443
    targetPort: ___
```

<details>
<summary>Answer</summary>

`externalIPs` and `8443`. `port` is what clients dial on the externalIP, and `targetPort` is the port the container listens on.

</details>

### Your turn: on your own

Two teammates disagree. One says: 'Use type: LoadBalancer with MetalLB for the 39,476 simulated BMC addresses, it's the same thing.' The other says externalIPs are a better fit. Give two concrete differences that matter for a simulator publishing tens of thousands of fixed BMC addresses.

<details>
<summary>Hint 1</summary>

Who picks the address in each case?

</details>

<details>
<summary>Hint 2</summary>

Who announces the address on the network, and does a simulator need that?

</details>

<details>
<summary>Hint 3</summary>

With MetalLB, think about pool size and ARP announcements multiplied by tens of thousands.

</details>

<details>
<summary>Answer</summary>

(1) With externalIPs the simulator chooses each address, so it can match the BMC address it assigned on NICo's BMC network. A LoadBalancer gets its address from a controller's pool. (2) externalIPs need no announcement: the site explorer runs inside the cluster, so kube-proxy's per-node rules are enough. MetalLB would allocate from a pool and send ARP for each VIP, which is machinery the simulator doesn't need. Either way, every node still tracks every address, so neither option escapes kube-proxy's per-node limits.

</details>

### Explain it

In your own words: In your own words, explain why an externalIP works from inside the cluster with no extra setup but stays unreachable from your laptop until you add a route.

### Check

**1. What does Kubernetes do when you add an address to a Service's externalIPs?**

A. Allocates it from the cluster's service CIDR
B. Announces it to the LAN with gratuitous ARP
C. Programs every node's kube-proxy to forward traffic for that IP and port to the Service
D. Assigns it to the pod's network interface

<details>
<summary>Answer</summary>

**C.** Programs every node's kube-proxy to forward traffic for that IP and port to the Service

That's all it does. Announcing addresses is MetalLB's job (Chapter 15). The service CIDR is for ClusterIPs, and the pod's interface keeps its own pod IP.

</details>

**2. How does machine-a-tron make each simulated BMC address reachable?**

A. One MetalLB VIP per BMC
B. A Service externalIP per simulated BMC and switch NVOS address
C. A separate kind cluster per rack
D. A NodePort per BMC on the control-plane node

<details>
<summary>Answer</summary>

**B.** A Service externalIP per simulated BMC and switch NVOS address

The sizing page says the simulator publishes every simulated BMC and switch NVOS address as a Service externalIP. The other options are plausible designs, but they aren't what it does.

</details>

**Sources:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

<a id="tokio-worker-threads"></a>
## 5. Tokio worker threads

*Builds on: Kubernetes resource limits (ch. 16), Asynchronous programming (async/await) (ch. 2)*

### Before you read

- You raise nico-api's CPU limit from 16 to 32, but it still never uses more than about 16 CPUs. Apart from the limit, what might cap it?
- Inside a container started with `docker run --cpus=2`, what does `nproc` print on an 8-core laptop?

<details>
<summary>Answers</summary>

- **You raise nico-api's CPU limit from 16 to 32, but it still never uses more than about 16 CPUs. Apart from the limit, what might cap it?** The number of threads the async runtime runs tasks on. With only 16 worker threads, at most 16 tasks run at the same moment, however much CPU the limit allows.
- **Inside a container started with `docker run --cpus=2`, what does `nproc` print on an 8-core laptop?** 8, all the host's logical CPUs. `--cpus` sets a cgroup quota and doesn't change which CPUs the container can see. (Some runtimes, including Tokio's default, read the quota as well. See the explanation.)

</details>

### Explanation

nico-api is written in async Rust and runs on **Tokio**, the most widely used Rust async runtime. Chapter 2 covered async/await: a task gives up control at each `.await` so others can run.

In Tokio's multi-threaded runtime, tasks run on a fixed pool of OS threads called **worker threads**. Each worker takes ready tasks off a queue and runs them until they reach an `.await`. Idle workers steal work from busy ones.

That gives a simple ceiling: **at any instant, at most N tasks are running on the CPU, where N is the worker thread count.** (Blocking work goes to a separate blocking pool, but nico-api's request handling and state controllers run as async tasks on the workers.) So:

- **Fewer workers than the CPU limit**: the extra CPU you granted sits unused.
- **Far more workers than the limit**: threads compete for the quota, and you get throttling and context switches.

How does Tokio choose the default? It uses the CPU count the Rust standard library reports (`available_parallelism`). On Linux that check reads the cgroup CPU quota, so under a 2-CPU limit Tokio usually starts 2 workers, even though `nproc` (a different tool, which ignores quotas) prints 8. The default is often right, then. You still set the count explicitly, for three reasons:

- It becomes a deliberate, visible number that you change in the same edit as the limit.
- You decide how a fractional limit such as `2500m` maps to a whole thread count, instead of leaving it to the runtime's detection.
- You don't depend on how a given runtime version or cgroup setup detects CPUs.

Tokio's runtime reads the `TOKIO_WORKER_THREADS` environment variable.

NICo's sizing guidance says to **raise the nico-api CPU limit and its Tokio worker thread count together**. The scale runs set `TOKIO_WORKER_THREADS` through the nico-api chart's `extraEnv` to match the CPU limit:

- 32 CPUs with 32 workers at 556 racks.
- 64 CPUs with 64 workers at 1,112 racks.

In the 556-rack run, the workers were 49% busy over the run and 59–68% busy while machines went `ready`, and nico-api peaked at 18.9 CPUs. So the extra headroom could actually be used. (That run also had other scaling fixes, so its faster time is a combined effect.)

nico-api runs as a single process with one worker pool, so the thread count really does limit how much CPU it can use.

**Analogy.** Worker threads are the checkout lanes that have a cashier, and the CPU limit is how many lanes the building has. Building 32 lanes doesn't help if only 16 cashiers turn up, and hiring 64 cashiers for 32 lanes just leaves them queuing for tills. The analogy breaks down because Tokio's workers are interchangeable and steal work from each other instantly, while real cashiers can't take over a customer halfway through.

### Worked example: See that a CPU quota is invisible to nproc, then pin the thread count

**Step 1: Compare visible CPUs with the quota.**

```bash
nproc
docker run --rm --cpus=2 debian:stable-slim sh -c 'echo nproc=$(nproc); cat /sys/fs/cgroup/cpu.max'
```
On an 8-CPU host you see `nproc=8`, then `200000 100000`. The quota says 2 CPUs, but `nproc` reports all 8 it can see. (`--cpuset-cpus` would change `nproc`, but Kubernetes CPU limits use quotas, not cpusets.) Tools differ in whether they look at the quota at all. Tokio's default usually does, `nproc` doesn't. That's one reason to write the number down explicitly.

**Step 2: Decide the target.**

The rule from the sizing guidance: worker threads = nico-api CPU limit. For a 32-CPU limit, that's 32.

**Step 3: Set it as a container env var.**

In plain Kubernetes this is an `env` entry next to `resources`:
```yaml
      containers:
      - name: api
        env:
        - name: TOKIO_WORKER_THREADS
          value: "32"
        resources:
          limits:
            cpu: "32"
```
For nico-api itself, the scale runs passed this variable through the chart's `extraEnv` value. Check the chart's values file for the exact shape before you edit.

**Step 4: Verify inside the running container.**

`kubectl exec <pod> -- printenv TOKIO_WORKER_THREADS` should print the same number as the CPU limit, and `cat /sys/fs/cgroup/cpu.max` should print `<limit×100000> 100000`.

### Your turn: finish it

You're moving nico-api to the 1,112-rack settings. Fill in the blanks so the thread count matches the CPU limit from the guidance.

```text
        env:
        - name: ___
          value: "64"
        resources:
          limits:
            cpu: ___
            memory: 64Gi
```

<details>
<summary>Answer</summary>

`TOKIO_WORKER_THREADS` and `"64"`. The 20,016-host row gives nico-api 64 CPUs and 64 GiB with 64 Tokio worker threads.

</details>

### Your turn: on your own

Hard-coding the thread count means keeping two numbers in step by hand. Use a Kubernetes feature to make `TOKIO_WORKER_THREADS` follow the container's CPU limit automatically. Write the env entry.

<details>
<summary>Hint 1</summary>

The Downward API can expose a container's own resource values as env vars.

</details>

<details>
<summary>Hint 2</summary>

Look for `valueFrom.resourceFieldRef`.

</details>

<details>
<summary>Hint 3</summary>

`resource: limits.cpu` with the default divisor of 1 gives whole CPUs, rounded up.

</details>

<details>
<summary>Answer</summary>

```yaml
        env:
        - name: TOKIO_WORKER_THREADS
          valueFrom:
            resourceFieldRef:
              resource: limits.cpu
```
With `cpu: "32"` the variable becomes `32`. A fractional limit such as `2500m` rounds up to `3`. This is a generic Kubernetes technique. Check whether your nico-api chart's `extraEnv` accepts `valueFrom` before relying on it there.

</details>

### Explain it

In your own words: Explain why giving nico-api 32 CPUs while leaving it on 16 worker threads would waste most of the increase, even though nico-api is 'async' and handles thousands of requests at once.

### Check

**1. What sets how many async tasks nico-api can run on the CPU at the same instant?**

A. Its memory limit
B. The number of Tokio worker threads
C. The number of Postgres connections
D. The node's total logical CPUs

<details>
<summary>Answer</summary>

**B.** The number of Tokio worker threads

Tasks run on worker threads, so the thread count caps parallelism. The node's CPU count and the CPU limit cap it from outside, but if there are fewer threads than the limit allows, the threads are the bottleneck. DB connections cap parallel queries, not CPU-bound task execution.

</details>

**2. How did NICo's large simulated runs set nico-api's worker thread count?**

A. A `--threads` flag on nico-api
B. The TOKIO_WORKER_THREADS environment variable through the chart's extraEnv, matching the CPU limit
C. Kubernetes sets it automatically from the CPU limit
D. A key in the [api_admission_control] table

<details>
<summary>Answer</summary>

**B.** The TOKIO_WORKER_THREADS environment variable through the chart's extraEnv, matching the CPU limit

That's what the sizing page describes. Kubernetes doesn't set it for you (you could wire that up yourself with the Downward API). Admission control limits requests, not threads. No `--threads` flag is documented.

</details>

**Sources:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

<a id="kube-proxy-ipvs-mode"></a>
## 6. kube-proxy IPVS mode

*Builds on: Kubernetes Service externalIP (ch. 16)*

### Before you read

- One simulated GB200 rack needs 89 Service address-and-port entries. If each node can hold at most 65,536 such entries, roughly how many racks fit?
- If you spread simulator pods across more nodes, does each node then hold fewer entries?

<details>
<summary>Answers</summary>

- **One simulated GB200 rack needs 89 Service address-and-port entries. If each node can hold at most 65,536 such entries, roughly how many racks fit?** 65,536 ÷ 89 ≈ 736 racks.
- **If you spread simulator pods across more nodes, does each node then hold fewer entries?** No. kube-proxy on every node programs every Service, so each node holds the full set no matter where the pods run.

</details>

### Explanation

**kube-proxy** runs on every node and turns Services into kernel packet-forwarding rules. It has several modes:

- **iptables**: chains of iptables rules.
- **nftables**: the newer mode, available on recent releases.
- **ipvs**: uses **IP Virtual Server (IPVS)**, the Linux kernel's built-in layer-4 load balancer.

In IPVS mode, kube-proxy on each node:

1. creates a dummy interface, `kube-ipvs0`, and binds every Service ClusterIP and externalIP to it, so the node treats those addresses as local;
2. creates an IPVS *virtual server* for each address:port, with the Service's endpoints as *real servers*;
3. keeps **ipsets** (kernel hash sets of addresses) so a handful of iptables rules can match whole groups of Service addresses at once. One of these sets records the externalIP-and-port pairs.

The catch for NICo's simulator is that this set holds **at most 65,536 entries**, a value compiled into kube-proxy. Every node holds the whole set, because every node's kube-proxy programs every Service. Adding nodes doesn't help.

The numbers from NICo's sizing page:

- A GB200 NVL72 rack with 2 DPUs per tray costs **89 entries**.
- 65,536 ÷ 89 ≈ **736 racks** for a stock simulator.
- Above that, the set fills, part of the fleet is unreachable from some nodes, and machine creation stalls.

The 1,112-rack runs used a kube-proxy **rebuilt with a larger set**. They also needed **longer calico-node probes**, because the BIRD daemon in calico-node went over its default probe timeout with about 89,000 addresses on each node's IPVS interface.

This is a **simulator limit, not a NICo limit**. A real site's BMCs are real hosts on the BMC network, not Services, so they never enter kube-proxy's tables. Recent Kubernetes releases favour nftables mode, so you may see a deprecation notice for IPVS mode.

**Analogy.** The ipset is like a fixed-size guest list at every entrance of a building. Every door keeps a copy of the whole list, so adding doors doesn't make room for more guests. You need a bigger list. The analogy breaks down because a full guest list just turns new people away at the door. A full ipset fails silently on some nodes, and the symptom shows up somewhere else entirely, as machine creation stalling.

### Worked example: Run kind with kube-proxy in IPVS mode and watch externalIPs land on kube-ipvs0

**Step 1: Create an IPVS-mode cluster.**

```bash
cat > kind-ipvs.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: ipvs-demo
networking:
  kubeProxyMode: "ipvs"
EOF
kind create cluster --config kind-ipvs.yaml
```

**Step 2: Confirm the mode.**

```bash
docker exec ipvs-demo-control-plane curl -s localhost:10249/proxyMode; echo
```
Prints `ipvs`. (Fallback: `kubectl -n kube-system get cm kube-proxy -o jsonpath='{.data.config\.conf}' | grep mode`.)

**Step 3: Create 10 Services with externalIPs.**

```bash
kubectl create deployment web --image=nginx:1.27
for i in $(seq 1 10); do
  kubectl expose deployment web --name=ext-$i --port=80 --external-ip=10.250.0.$i
done
```

**Step 4: Count them on the node.**

```bash
docker exec ipvs-demo-control-plane ip -4 -o addr show kube-ipvs0 | grep -c ' 10\.250\.0\.'
```
Prints `10`: each externalIP is bound locally on every node. If your kube-proxy image includes `ipset`, `kubectl -n kube-system exec ds/kube-proxy -- ipset list KUBE-EXTERNAL-IP | grep -i entries` shows the IP-and-port entries that count against the 65,536 cap.

**Step 5: Scale the arithmetic.**

10 entries out of 65,536 is nothing. A rack costs 89. 736 racks × 89 = 65,504, which fits. 737 × 89 = 65,593, which doesn't. Clean up with `kind delete cluster --name ipvs-demo`.

### Your turn: finish it

Complete the kind config so kube-proxy runs in the mode whose ipset limits the simulator, with two worker nodes.

```text
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  kubeProxyMode: ___
nodes:
- role: control-plane
- role: ___
- role: worker
```

<details>
<summary>Answer</summary>

`"ipvs"` and `worker`.

</details>

### Your turn: on your own

You plan simulated GB200 NVL72 fleets (2 DPUs per tray) of 400, 556 and 1,112 racks on a stock kube-proxy in IPVS mode. For each fleet, how many externalIP entries does each node need, and does it fit? Which fleets need the rebuilt kube-proxy?

<details>
<summary>Hint 1</summary>

Use 89 entries per rack.

</details>

<details>
<summary>Hint 2</summary>

Compare each product with 65,536.

</details>

<details>
<summary>Hint 3</summary>

400 × 89 = 35,600. Do the other two.

</details>

<details>
<summary>Answer</summary>

400 racks = 35,600, which fits. 556 racks = 49,484, which fits. 1,112 racks = 98,968, which doesn't fit (it's above the ~736-rack ceiling), so only the 1,112-rack fleet needs the larger set. That run also needed longer calico-node probes.

</details>

### Explain it

In your own words: Why does adding more Kubernetes nodes, or more simulator pods, do nothing to raise the ~736-rack ceiling?

### Check

**1. Where does the 65,536-entry limit live?**

A. In NICo's site explorer configuration
B. In kube-proxy's IPVS ipset, compiled into kube-proxy, once per node
C. In the BMC network's /16 subnet
D. In Calico's IP pool

<details>
<summary>Answer</summary>

**B.** In kube-proxy's IPVS ipset, compiled into kube-proxy, once per node

65,536 is also the size of a /16, which is why the BMC subnet option is tempting. That's a separate sizing input (78,952 BMC addresses needed two /16 segments). The kube-proxy limit is a property of the simulator setup, not of NICo.

</details>

**2. Does a real site with 1,112 GB200 racks hit this limit?**

A. Yes, it needs the rebuilt kube-proxy too
B. No, real BMCs are hosts on the BMC network, not Service externalIPs
C. Only if Calico is used
D. Only on arm64 nodes

<details>
<summary>Answer</summary>

**B.** No, real BMCs are hosts on the BMC network, not Service externalIPs

The sizing page calls it a simulator limit that a site with real hardware does not share.

</details>

**3. Besides a larger ipset, what other cluster change did the 1,112-rack simulation need?**

A. Disabling Calico
B. Longer calico-node probes, because BIRD timed out with ~89,000 addresses on the IPVS interface
C. Switching kube-proxy to iptables mode
D. A second Kubernetes cluster

<details>
<summary>Answer</summary>

**B.** Longer calico-node probes, because BIRD timed out with ~89,000 addresses on the IPVS interface

That's what the documented runs did. The runs didn't switch modes or add clusters.

</details>

**Sources:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

<a id="machine-a-tron"></a>
## 7. Machine-a-tron

*Builds on: Baseboard Management Controller (BMC) (ch. 6), Kubernetes Service externalIP (ch. 16)*

### Before you read

- You want to know whether NICo's control plane can bring 20,000 hosts to `ready`, but you have no racks. What would you need to fake?
- Guess: would a simulated run tell you how long firmware flashing takes on real hardware?

<details>
<summary>Answers</summary>

- **You want to know whether NICo's control plane can bring 20,000 hosts to `ready`, but you have no racks. What would you need to fake?** Everything NICo talks to: the BMCs (Redfish), the host and DPU agents, and the external services it calls, such as rack management and NVLink controllers. The control plane itself runs for real.
- **Guess: would a simulated run tell you how long firmware flashing takes on real hardware?** No. A simulation exercises the control plane, not device timing or firmware flashing.

</details>

### Explanation

**Machine-a-tron** is NICo's fleet simulator. It runs **simulated BMCs and agents in Kubernetes pods**, behind a **protocol gateway**, so the real NICo control plane can be scale-tested with no hardware.

Each simulated BMC is published as a Service `externalIP` (see the earlier lesson). nico-api's site explorer probes those addresses the same way it would probe real BMCs over Redfish (Chapter 6).

NICo's "Simulation" rows used other fakes alongside machine-a-tron: the **DOCA Platform Framework (DPF) simulator** for DPU provisioning, a **Rack Management Service (RMS) mock** for rack setup, and an **NMX Controller (NMX-C) mock** for NVLink partitions.

**What it exercises:** discovery, machine creation, the state controllers, rack setup and NVLink partition creation.

**What it doesn't:** device timing, firmware flashing, the DPU data plane (HBN), GPU health and telemetry, or tenant workloads.

**Fleet-up** is the starting point of the clock the scale figures use. It's the moment every simulator pod is Ready, the protocol gateway answers, and the controller has published every pod's Services.

Sizing a simulated fleet means counting endpoints. A GB200 NVL72 rack with 2 DPUs per tray has 18 host + 36 DPU + 9 switch tray + 8 power shelf BMCs. That's **71 endpoints** and **54 machines** (hosts plus DPUs). The 1,112-rack runs needed:

- 78,952 BMC addresses, more than one `/16` holds, so BMC leases were split between two `/16` segments;
- **45 simulator pods**;
- the rebuilt kube-proxy from the last lesson.

One simulator quirk: every simulated agent presents **one client identity**, so nico-api's per-client admission limits apply to the whole fleet at once. A 556-rack run with admission control enabled at raised limits rejected 86% of calls and stalled with no rack `ready`. The guidance is to **disable admission control for a simulated fleet and keep it enabled on real hardware**. The nico-api chart value `apiAdmissionControl.enabled` switches it.

The repo can build the simulator's development images with `make images-dev DEV_TARGET=machine-a-tron` and `DEV_TARGET=mat-protocol-gateway`.

**Analogy.** Machine-a-tron is like a simulator for air-traffic controllers: thousands of fake planes on the radar, all answering on the radio, so the controllers' procedures get tested at full volume. The analogy breaks down because a flight simulator models physics carefully, while machine-a-tron deliberately doesn't model device timing. A simulated time-to-ready is a control-plane number, not a promise for real hardware.

### Worked example: Plan the resources for a 556-rack simulated fleet

**Step 1: Count endpoints and machines.**

71 endpoints × 556 racks = **39,476** BMC addresses. 54 machines × 556 = **30,024** machines (10,008 hosts + 20,016 DPUs). Both match the sizing table.

**Step 2: Check the BMC address space.**

A /16 has 65,536 addresses, so 39,476 fits in one /16. (1,112 racks would need 78,952 addresses and two /16 segments.)

**Step 3: Check the kube-proxy ipset.**

89 entries × 556 = 49,484, which is under 65,536, so a stock IPVS kube-proxy is fine.

**Step 4: Set the simulator-only switches.**

Disable API admission control for this run (`apiAdmissionControl.enabled` in the nico-api chart). On real hardware, leave it enabled and watch `carbide_api_admission_rejected_total`.

**Step 5: Build the simulator images (if you have the repo).**

From the infra-controller repo root, with a Linux amd64/arm64 Docker daemon that supports BuildKit:
```bash
make images-dev DEV_TARGET=machine-a-tron
make images-dev DEV_TARGET=mat-protocol-gateway
```
This produces `nico-dev-machine-a-tron:latest` and `nico-dev-mat-protocol-gateway:latest` locally. It doesn't push them, load them into kind or deploy anything.

**Step 6: Know what the result will and won't mean.**

A time-to-`ready` from this run measures discovery, machine creation and the state controllers. It says nothing about firmware flash times or the HBN data plane.

### Your turn: finish it

Fill in the blanks for a 250-rack GB200 NVL72 simulated fleet (2 DPUs per tray).

```text
BMC endpoints = 71 × 250 = ___
machines      = 54 × 250 = 13,500
ipset entries = 89 × 250 = 22,250  -> stock kube-proxy OK? ___
```

<details>
<summary>Answer</summary>

17,750 endpoints, which matches the sizing page's 250-rack BMC address figure. And yes, a stock kube-proxy is fine: 22,250 is well under 65,536.

</details>

### Your turn: on your own

A colleague's simulated run finishes in 6 hours, and they want to tell a customer 'your 400-rack site will be ready in 6 hours'. They also ran it once with admission control enabled 'to be realistic', and that run stalled. Write a short reply that covers both points.

<details>
<summary>Hint 1</summary>

List what the simulation doesn't exercise.

</details>

<details>
<summary>Hint 2</summary>

How many client identities does a simulated fleet present, and what does that do to per-client limits?

</details>

<details>
<summary>Hint 3</summary>

Recommend a setting for simulation, and a setting plus a counter to watch for real hardware.

</details>

<details>
<summary>Answer</summary>

Something like: 'The simulation measures the control plane (discovery, machine creation, state controllers) from fleet-up. It doesn't include device timing, firmware flashing, the DPU data plane or tenant workloads, so 6 hours is a lower bound for that part, not a promise for real racks. The stall is a simulator artefact: every simulated agent shares one client identity, so the per-client admission limits throttle the whole fleet at once. Disable admission control for simulations. On real hardware, where each agent has its own identity, keep it enabled and watch `carbide_api_admission_rejected_total` as the fleet grows.'

</details>

### Explain it

In your own words: Given everything a simulation leaves out, why is it still worth scale-testing the control plane against fake BMCs?

### Check

**1. Which of these does a machine-a-tron simulation exercise?**

A. Firmware flashing duration
B. HBN data-plane throughput on DPUs
C. Machine discovery and state controller progress to ready
D. GPU telemetry collection

<details>
<summary>Answer</summary>

**C.** Machine discovery and state controller progress to ready

The sizing page lists discovery, machine creation, state controllers, rack setup and NVLink partition creation as exercised. Firmware flashing, the DPU data plane and GPU telemetry aren't.

</details>

**2. Why should API admission control be disabled for a simulated fleet?**

A. The simulator doesn't speak gRPC
B. Every simulated agent presents one client identity, so per-client limits throttle the whole fleet
C. Admission control only works on arm64
D. It doubles Postgres memory use

<details>
<summary>Answer</summary>

**B.** Every simulated agent presents one client identity, so per-client limits throttle the whole fleet

That's the documented cause of the 86% rejection rate and the stalled run. On real hardware each agent has its own identity, so keep admission control enabled there.

</details>

**3. When does the 'fleet-up' clock start?**

A. When nico-api starts
B. When every simulator pod is Ready, the protocol gateway answers, and every pod's Services are published
C. When the first machine reaches ready
D. When the kind cluster is created

<details>
<summary>Answer</summary>

**B.** When every simulator pod is Ready, the protocol gateway answers, and every pod's Services are published

All the simulated time figures count from that point, so time spent creating the cluster or starting nico-api isn't included.

</details>

**Sources:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

<a id="build-task"></a>
## Build task: A mini scale lab: fake BMC fleet, anti-affinity, matched threads and OOM signals on kind

**Goal:** On a 3-node kind cluster with kube-proxy in IPVS mode, run a 'fake-api' and a 'fake-db' that must sit on different nodes, with a worker-thread env var tied to the API's CPU limit. Also run one simulator pod that answers Redfish-style JSON for 20 BMC addresses published as Service externalIPs. Then show the difference between page-cache growth and a real OOM kill.

**Why it matters for NICo:** This is a laptop-sized model of the settings behind NICo's 10,000- and 20,000-host runs. Limits cap nico-api and Postgres. A required anti-affinity keeps them apart. TOKIO_WORKER_THREADS has to match the CPU limit. You judge memory by oom_kill, not by the working set. And a simulator publishes every BMC as an externalIP that every node's IPVS kube-proxy has to track. Machine-a-tron does all this for real at a much larger scale. The fake BMC server here only shows the mechanism and is not machine-a-tron itself.

**You need:**

- Docker (Docker Desktop on macOS or Docker Engine on Linux). On macOS, give the VM at least 4 GiB of RAM
- kind (v0.20 or later) and kubectl
- A cgroup v2 host (any current Linux distro or Docker Desktop). Check with `docker info | grep -i cgroup`
- Linux hosts: IPVS kernel modules available (`sudo modprobe ip_vs ip_vs_rr ip_vs_wrr ip_vs_sh` if needed)
- Internet access to pull busybox:1.36, python:3.12-slim, debian:stable-slim and curlimages/curl

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Create the IPVS cluster</summary>

```bash
cat > kind-scale.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: scale-lab
networking:
  kubeProxyMode: "ipvs"
nodes:
- role: control-plane
- role: worker
- role: worker
EOF
kind create cluster --config kind-scale.yaml
docker exec scale-lab-worker curl -s localhost:10249/proxyMode; echo
```
The last command should print `ipvs`.

</details>

<details>
<summary>Step 2: Deploy fake-db and fake-api with limits, anti-affinity and matched threads</summary>

```bash
kubectl apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fake-db
spec:
  replicas: 1
  selector:
    matchLabels:
      app: fake-db
  template:
    metadata:
      labels:
        app: fake-db
    spec:
      containers:
      - name: db
        image: busybox:1.36
        command: ["sh", "-c", "sleep 1000000"]
        resources:
          requests:
            cpu: 100m
            memory: 64Mi
          limits:
            cpu: "1"
            memory: 128Mi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fake-api
spec:
  replicas: 1
  selector:
    matchLabels:
      app: fake-api
  template:
    metadata:
      labels:
        app: fake-api
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: fake-db
            topologyKey: kubernetes.io/hostname
      containers:
      - name: api
        image: busybox:1.36
        command: ["sh", "-c", "sleep 1000000"]
        env:
        - name: TOKIO_WORKER_THREADS
          valueFrom:
            resourceFieldRef:
              resource: limits.cpu
        resources:
          requests:
            cpu: 100m
            memory: 64Mi
          limits:
            cpu: "2"
            memory: 256Mi
EOF
kubectl get pods -l 'app in (fake-api,fake-db)' -o wide
kubectl exec deploy/fake-api -- sh -c 'echo threads=$TOKIO_WORKER_THREADS; cat /sys/fs/cgroup/cpu.max'
```
Expect the two pods on different workers, `threads=2` and `200000 100000`.

</details>

<details>
<summary>Step 3: Run one simulator pod for many fake BMCs</summary>

One pod answers for every address and works out which 'BMC' it is from the HTTP Host header, the way one simulator pod hosts many BMCs:
```bash
kubectl apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fake-bmc-sim
spec:
  replicas: 1
  selector:
    matchLabels:
      app: fake-bmc-sim
  template:
    metadata:
      labels:
        app: fake-bmc-sim
    spec:
      containers:
      - name: sim
        image: python:3.12-slim
        command: ["python3", "-u", "-c"]
        args:
        - |
          import http.server, json
          class H(http.server.BaseHTTPRequestHandler):
              def do_GET(self):
                  host = (self.headers.get("Host") or "unknown").split(":")[0]
                  body = json.dumps({"@odata.id": "/redfish/v1", "Id": "RootService", "Name": "simulated BMC " + host}).encode()
                  self.send_response(200)
                  self.send_header("Content-Type", "application/json")
                  self.send_header("Content-Length", str(len(body)))
                  self.end_headers()
                  self.wfile.write(body)
          http.server.ThreadingHTTPServer(("", 8000), H).serve_forever()
        ports:
        - containerPort: 8000
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 500m
            memory: 128Mi
EOF
kubectl wait --for=condition=Available deployment/fake-bmc-sim --timeout=180s
```

</details>

<details>
<summary>Step 4: Publish 20 BMC addresses as externalIPs</summary>

```bash
for i in $(seq 1 20); do
cat <<EOF
---
apiVersion: v1
kind: Service
metadata:
  name: bmc-$i
  labels:
    lab: fake-bmc
spec:
  selector:
    app: fake-bmc-sim
  externalIPs:
  - 10.250.0.$i
  ports:
  - port: 80
    targetPort: 8000
EOF
done | kubectl apply -f -

kubectl run curl --rm -i --restart=Never --image=curlimages/curl -- -s http://10.250.0.7/redfish/v1
docker exec scale-lab-worker ip -4 -o addr show kube-ipvs0 | grep -c ' 10\.250\.0\.'
```
You should see `{"@odata.id": "/redfish/v1", "Id": "RootService", "Name": "simulated BMC 10.250.0.7"}` and the count `20`. Run the same `docker exec` against `scale-lab-worker2`. It also shows 20, because every node holds every address.

</details>

<details>
<summary>Step 5: Contrast page cache with a real OOM kill</summary>

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: cache
spec:
  containers:
  - name: cache
    image: debian:stable-slim
    command: ["sh", "-c", "dd if=/dev/zero of=/tmp/big bs=1M count=300 status=none; sleep 1000000"]
    resources:
      limits:
        memory: 128Mi
---
apiVersion: v1
kind: Pod
metadata:
  name: hog
spec:
  containers:
  - name: hog
    image: python:3.12-slim
    command: ["python3", "-c", "import time; x = b'x' * (200*1024*1024); time.sleep(3600)"]
    resources:
      limits:
        memory: 64Mi
EOF
sleep 60
kubectl get pods cache hog
kubectl exec cache -- sh -c 'cat /sys/fs/cgroup/memory.current; grep -E "^(anon|active_file|inactive_file) " /sys/fs/cgroup/memory.stat; grep -E "^oom_kill " /sys/fs/cgroup/memory.events'
```
`cache` should be `Running`, with mostly file memory and `oom_kill 0`, even though it wrote 300 MiB under a 128 MiB limit. `hog` should show `OOMKilled` or `CrashLoopBackOff`, and its restart count goes up each time you check.

</details>

<details>
<summary>Step 6: Run the verification script</summary>

Save this as `verify.sh` and run `bash verify.sh`:
```bash
#!/usr/bin/env bash
set -u
pass=0; fail=0
check() { if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
check "kube-proxy in ipvs mode" '[ "$(docker exec scale-lab-worker curl -s localhost:10249/proxyMode)" = ipvs ]'
api_node=$(kubectl get pod -l app=fake-api -o jsonpath='{.items[0].spec.nodeName}')
db_node=$(kubectl get pod -l app=fake-db -o jsonpath='{.items[0].spec.nodeName}')
check "api and db on different nodes ($api_node / $db_node)" '[ -n "$api_node" ] && [ "$api_node" != "$db_node" ]'
check "TOKIO_WORKER_THREADS matches CPU limit" '[ "$(kubectl exec deploy/fake-api -- printenv TOKIO_WORKER_THREADS)" = 2 ]'
check "20 externalIPs on kube-ipvs0" '[ "$(docker exec scale-lab-worker ip -4 -o addr show kube-ipvs0 | grep -c " 10\.250\.0\.")" -eq 20 ]'
check "fake BMC answers on 10.250.0.7" 'kubectl run vcurl --rm -i --restart=Never --image=curlimages/curl -- -s --max-time 5 http://10.250.0.7/redfish/v1 2>/dev/null | grep -q "simulated BMC 10.250.0.7"'
check "hog was OOM killed" '[ "$(kubectl get pod hog -o jsonpath="{.status.containerStatuses[0].lastState.terminated.reason}")" = OOMKilled ]'
check "cache pod survived with oom_kill 0" 'kubectl exec cache -- grep -qx "oom_kill 0" /sys/fs/cgroup/memory.events'
echo "$pass passed, $fail failed"
```

</details>

**Check it works:** `bash verify.sh` prints 7 PASS lines and ends with `7 passed, 0 failed`.

<details>
<summary>If you get stuck</summary>

- `proxyMode` prints nothing, or kube-proxy pods crash-loop: the IPVS kernel modules are missing on a Linux host. Run `sudo modprobe ip_vs ip_vs_rr ip_vs_wrr ip_vs_sh nf_conntrack`, then delete and recreate the cluster. `kubectl -n kube-system logs ds/kube-proxy` shows the exact error. A deprecation warning about IPVS mode is harmless.
- `curl` isn't found in the kind node: check the mode with `kubectl -n kube-system get cm kube-proxy -o jsonpath='{.data.config\.conf}' | grep mode` instead, and change the first check in verify.sh to match.
- fake-api is Pending: run `kubectl describe pod -l app=fake-api`. If the event mentions anti-affinity, you probably created the cluster without two workers. `kubectl get nodes` should list scale-lab-worker and scale-lab-worker2.
- The curl to 10.250.0.7 times out: run `kubectl get endpoints bmc-7`. If it's empty, the sim pod isn't Ready yet (python:3.12-slim can take a while to pull). Check `kubectl logs deploy/fake-bmc-sim`.
- `hog` shows Running instead of being OOM killed: swap may be enabled on the node and absorbing the allocation. Raise the allocation in the command to 400 MiB, or check `docker info` for swap settings. The lastState check only passes after the first kill, so wait about 30 seconds.
- `/sys/fs/cgroup/memory.events` doesn't exist: the host uses cgroup v1. Use a current Linux distro or Docker Desktop, or read `memory.oom_control` instead and adjust the check.
- Using Podman: set `KIND_EXPERIMENTAL_PROVIDER=podman` and replace `docker exec` with `podman exec` in the commands and the script.

</details>

**Stretch goal:** Add a second port (443 → 8000) to every bmc-* Service. Then show that the address count on kube-ipvs0 stays at 20 while the IPVS entries double. Use `kubectl -n kube-system exec <kube-proxy pod on scale-lab-worker> -- ipset list KUBE-EXTERNAL-IP | grep -i entries` if the image has ipset. Otherwise, install `ipvsadm` in a privileged debug pod with host networking and count the lines of `ipvsadm -Ln`. From your per-BMC cost, work out how many fake 'racks' of 71 BMCs a stock 65,536-entry set would hold. Compare that with the documented cost of 89 entries per GB200 rack and the ceiling of roughly 736 racks.

## Review notes

The draft was rewritten once using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (build task): Step 2 runs `kubectl exec deploy/fake-api ...` immediately after `kubectl apply` with no wait. On a fresh cluster the busybox image may still be pulling, so the exec fails (container not running / pod Pending) and the learner sees an error instead of `threads=2` and `200000 100000`. *Fix:* Add `kubectl rollout status deployment/fake-db deployment/fake-api --timeout=120s` (or `kubectl wait --for=condition=Available deployment/fake-db deployment/fake-api`) before the `get pods` and `exec` lines.
- **minor** (Tokio worker threads): The explanation says nico-api's request handling and state controllers run as async tasks on the Tokio workers. That claim about nico-api internals isn't in the sizing page, which only says nico-api runs as one process with Tokio worker threads whose count is set through TOKIO_WORKER_THREADS. *Fix:* Soften it to a general statement (e.g. 'much of nico-api's work runs as async tasks on the worker pool') or cite a source that describes nico-api's task model.

---

[← 15-cluster-networking.md](15-cluster-networking.md) · [17-helm-gitops-installation-setup.md →](17-helm-gitops-installation-setup.md)
