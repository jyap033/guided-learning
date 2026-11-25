# Chapter 14: Kubernetes Basics

*Part: Kubernetes & Deployment · 8 concepts · [curriculum](../curriculum.md#chapter-14)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

NICo isn't a single program you install on a server. As Chapter 5 showed, it is a set of microservices: `nico-api`, `nico-dhcp`, `nico-pxe`, `nico-dns`, the SSH console and others. They run on a **Kubernetes** cluster of at least three nodes in the datacenter, together with prerequisites such as PostgreSQL, Vault, cert-manager, External Secrets and MetalLB. Almost every install step, health check and troubleshooting command in the NICo docs is a `kubectl` command, so you need to be comfortable with Kubernetes before you deploy NICo.

This chapter covers the parts of Kubernetes the NICo docs rely on. It starts with a networking idea: the **virtual IP address**, a stable address that belongs to a service rather than to a machine. This matters because your DHCP relays and DNS records have to point at NICo before NICo even boots. Next comes Kubernetes itself and the objects you will see all the time: Pods, StatefulSets, Jobs, ConfigMaps, Secrets and Services. Then the extension mechanism, **Custom Resources**, which MetalLB, cert-manager, the Postgres operator and DPF all use. The last four lessons cover Service types, persistent storage, RBAC and Secrets.

Everything here runs on a laptop with `kind` (Kubernetes-in-Docker). You can't run NICo on a laptop, but you can create and inspect the same kinds of objects that NICo's `setup.sh` creates. So when the Quick Start tells you to run `kubectl get svc -n nico-system | grep LoadBalancer` and look for `<pending>`, you'll know what you're looking at.

You'll use this chapter right away. Chapter 15 builds MetalLB VIPs and L2/BGP advertisement on top of the Service types covered here. Chapter 17 adds Helm, Kustomize and the Postgres operator. Chapters 19–21 cover cert-manager, Vault and ESO, which are all built from CRs, Secrets and RBAC.

**By the end of this chapter you can:**

- Explain why each NICo Core LoadBalancer service needs a fixed virtual IP from the MetalLB pool, and pick valid, unique VIPs from a CIDR range
- Create a local Kubernetes cluster with kind and use kubectl to inspect nodes, Pods, StatefulSets, Jobs, ConfigMaps, Secrets and Services
- Define a CustomResourceDefinition, create a custom resource and explain what an operator adds
- Choose between ClusterIP, NodePort and LoadBalancer Services, and diagnose a LoadBalancer stuck in <pending>
- Provision durable storage with a StorageClass and PersistentVolumeClaims, and predict the PVC names a StatefulSet creates
- Grant a ServiceAccount least-privilege access with a Role and RoleBinding, consume a Secret from a Pod, and check both with kubectl

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [Virtual IP address (VIP)](#virtual-ip-address)
2. [Kubernetes](#kubernetes)
3. [Kubernetes workload and config objects](#kubernetes-workload-and-config-objects)
4. [Kubernetes Custom Resource (CR/CRD)](#kubernetes-custom-resource)
5. [Kubernetes Service types (LoadBalancer, NodePort, ClusterIP)](#kubernetes-service-types)
6. [Persistent storage (StorageClass, PVC, local-path-provisioner)](#persistent-storage)
7. [Kubernetes RBAC](#kubernetes-rbac)
8. [Kubernetes Secret](#kubernetes-secret)
9. [Build task: A mini "site controller" on kind](#build-task)

<a id="virtual-ip-address"></a>
## 1. Virtual IP address (VIP)

*Builds on: IP addressing basics (ch. 3)*

### Before you read

- Your OOB switches relay every BMC DHCP request to one IP address. NICo's DHCP service runs as a container that Kubernetes might restart on a different server tomorrow. Which IP should the relay point at?
- Suppose the address of NICo's API changed every time you reinstalled. What would break?

<details>
<summary>Answers</summary>

- **Your OOB switches relay every BMC DHCP request to one IP address. NICo's DHCP service runs as a container that Kubernetes might restart on a different server tomorrow. Which IP should the relay point at?** An address that belongs to the DHCP service itself, not to any one server. That is a virtual IP (VIP). Wherever the service runs, it answers on that same address.
- **Suppose the address of NICo's API changed every time you reinstalled. What would break?** Anything configured ahead of time: DNS records for the API hostname, DHCP relay targets, PXE settings and client configs. The docs warn that random IPs on each install mean these "cannot be pre-configured and will break on redeploy".

</details>

### Explanation

In Chapter 3 every IP address sat on an interface of one machine. A **virtual IP address (VIP)** works differently. It is assigned to a *service*, and whichever machine is currently running that service answers for it. If that machine dies or the service moves, another machine takes over the same address. Clients notice nothing because they only ever knew the VIP.

This matters a lot for NICo. Its control plane services (`nico-api`, `nico-dhcp`, `nico-dns`, `nico-pxe`, `nico-ssh-console-rs`) run as containers on a Kubernetes cluster of at least three nodes, and Kubernetes can move them to any node. Yet the rest of the datacenter has to reach them at known addresses:

- OOB switches relay BMC DHCP requests to the `nico-dhcp` VIP.
- External DNS must resolve the `nico-api` hostname to the `nico-api` VIP.
- Managed hosts fetch boot artifacts from the `nico-pxe` VIP.

In NICo's reference design, **MetalLB** hands out these VIPs from IP address pools that you define. The example file has an *internal* pool (`10.180.126.160/28`) and an *external* pool (`10.180.126.176/28`). The Quick Start is explicit: each NICo Core LoadBalancer service needs a **specific, stable IP** from the pool. Without explicit assignments, MetalLB picks IPs at random on each install, so relays, DNS and PXE can't be configured in advance. Each VIP must fall inside a pool you defined and must be unique across services. Some services have several replicas that each need their own address, such as the two `nico-dns` instances or the three `nico-ntp` replicas. Those get one VIP per pod through `perPodAnnotations`.

How does the network learn which node currently holds a VIP? In Layer 2 mode, the holder answers ARP requests for it. In BGP mode, nodes advertise the VIP as a route to the ToR. Chapter 15 covers both. In the reference architecture, MetalLB advertises L3 LoadBalancer VIPs toward the DPU uplinks or the ToR switches.

**Analogy.** A VIP is like a company's main phone number. Whoever is on reception duty picks up, and when they go on break a colleague takes over the line, so callers never need a new number. The analogy breaks down at the switchover. A phone system reroutes the call instantly, but on a network the switches and neighbours have to *learn* the new holder (through gratuitous ARP or a BGP update). Until they do, traffic can briefly go to the old machine.

### Worked example: Move a VIP between two servers and watch the client keep working

**Step 1: Start a lab container with network namespaces.**

Each network namespace acts as a separate machine. All of them plug into one bridge, like hosts on one switch.
```bash
docker run --rm -it --privileged debian:stable-slim bash
# inside the container:
apt-get update && apt-get install -y iproute2 curl python3
ip link add br0 type bridge && ip link set br0 up
for n in client srvA srvB; do
  ip netns add $n
  ip link add v-$n type veth peer name eth0 netns $n
  ip link set v-$n master br0 up
  ip -n $n link set lo up
  ip -n $n link set eth0 up
done
ip -n client addr add 10.0.0.1/24 dev eth0
ip -n srvA addr add 10.0.0.11/24 dev eth0
ip -n srvB addr add 10.0.0.12/24 dev eth0
```

**Step 2: Run the same service on both servers.**

```bash
mkdir -p /srv/a /srv/b
echo 'served by srvA' > /srv/a/index.html
echo 'served by srvB' > /srv/b/index.html
ip netns exec srvA python3 -m http.server 80 -d /srv/a 2>/dev/null &
ip netns exec srvB python3 -m http.server 80 -d /srv/b 2>/dev/null &
```

**Step 3: Give the VIP to srvA and use it from the client.**

```bash
ip -n srvA addr add 10.0.0.100/24 dev eth0
ip netns exec client curl -s http://10.0.0.100/
# served by srvA
```
The client only knows `10.0.0.100`. It doesn't know srvA's own address, `10.0.0.11`.

**Step 4: Fail over: move the VIP to srvB.**

```bash
ip -n srvA addr del 10.0.0.100/24 dev eth0
ip -n srvB addr add 10.0.0.100/24 dev eth0
ip -n client neigh flush all   # forget the old MAC for 10.0.0.100
ip netns exec client curl -s http://10.0.0.100/
# served by srvB
```
The client's configuration didn't change. Flushing the neighbour (ARP) table here stands in for what MetalLB's L2 mode does in real life, where the new holder announces itself with gratuitous ARP (Chapter 15). Run `ip -n client neigh` before and after the move and you'll see the MAC address behind `10.0.0.100` change.

**Step 5: Connect it to NICo.**

Replace `10.0.0.100` with the `nico-dhcp` VIP and "client" with your OOB switch's DHCP relay. The relay keeps forwarding to one address, and the node behind that address can change at any time.

### Your turn: finish it

Your MetalLB internal pool is `10.180.126.160/28` and your external pool is `10.180.126.176/28`. Following the table in the Quick Start's Step 3h, assign VIPs. Each IP must be inside the right pool and unique. Fill in the blanks.

```text
| Service | Values key | Pool | VIP |
|---|---|---|---|
| nico-api | nico-api.externalService.annotations | External | 10.180.126.177 |
| nico-dhcp | nico-dhcp.externalService.annotations | Internal | 10.180.126.161 |
| nico-dns instance-0 | nico-dns.externalService.perPodAnnotations[0] | Internal | 10.180.126.162 |
| nico-dns instance-1 | ___ | Internal | 10.180.126.163 |
| nico-pxe | nico-pxe.externalService.annotations | Internal | ___ |
| nico-ssh-console-rs | nico-ssh-console-rs.externalService.annotations | Internal | 10.180.126.165 |
```

<details>
<summary>Answer</summary>

nico-dns instance-1 uses `nico-dns.externalService.perPodAnnotations[1]`. nico-pxe needs an unused internal address, for example `10.180.126.164`. Any address in 10.180.126.160–175 that isn't already taken works. Also remember that `nico-dhcp` needs `externalService.enabled: true` set explicitly.

</details>

### Your turn: on your own

A colleague suggests leaving all the VIP annotations out of `nico-core.yaml` and letting MetalLB choose, then updating the switch DHCP relay and DNS after each install. Give two concrete reasons this is a bad idea, and say which addresses you must hand to the network team *before* the first install.

<details>
<summary>Hint 1</summary>

Think about what happens on a reinstall or redeploy, not just the first install.

</details>

<details>
<summary>Hint 2</summary>

Which external systems are configured outside Kubernetes and point at NICo services?

</details>

<details>
<summary>Hint 3</summary>

The Quick Start names the DHCP relay, DNS records, PXE config and API hostname. Step 6 configures the relay to forward to the nico-dhcp VIP.

</details>

<details>
<summary>Answer</summary>

(1) MetalLB may pick different IPs on each install. Every redeploy then silently breaks the DHCP relay targets, DNS A records, PXE settings and the API hostname until someone notices and fixes them by hand. (2) Those external systems have to be configured in advance. BMCs start sending DHCP requests as soon as they are powered, and the `nico-api` hostname must already resolve to its VIP. Before the first install, give the network team the `nico-dhcp` VIP (relay target), the `nico-api` VIP (DNS A record for the API hostname), the `nico-dns` VIPs, the `nico-pxe` VIP and the SSH console VIP. Also give them the pool CIDRs so they can route and advertise them.

</details>

### Explain it

In your own words: In your own words, explain why a stateless service like `nico-dhcp`, which can run on any node, still needs a stable address that the rest of the datacenter knows about. How does a VIP provide that without pinning the service to one machine?

### Check

**1. Why does the Quick Start ask you to assign each NICo Core LoadBalancer service a specific VIP?**

A. MetalLB cannot allocate addresses unless you list them per service
B. Without explicit VIPs, MetalLB picks IPs randomly on each install, so DHCP relays, DNS and PXE can't be configured in advance
C. Kubernetes refuses to create a LoadBalancer Service without an IP annotation
D. A fixed VIP makes the service run faster

<details>
<summary>Answer</summary>

**B.** Without explicit VIPs, MetalLB picks IPs randomly on each install, so DHCP relays, DNS and PXE can't be configured in advance

MetalLB can allocate addresses automatically, and the docs say existing configs may omit annotations for automatic allocation. The problem is that the address isn't stable across installs. Kubernetes doesn't require the annotation, and the choice of IP has no effect on speed.

</details>

**2. Which statement about a VIP is correct?**

A. It is permanently bound to one physical NIC
B. It belongs to a service, and whichever machine currently holds it answers for it
C. It is a private address that only works inside a Kubernetes Pod
D. It replaces the need for each node to have its own IP

<details>
<summary>Answer</summary>

**B.** It belongs to a service, and whichever machine currently holds it answers for it

The point of a VIP is that it isn't tied to one machine. Nodes still keep their own IPs. NICo's VIPs are reachable from the underlay, not just from inside pods.

</details>

**3. `nico-dns` runs two replicas, and each needs its own VIP. Which values key do you use instead of `annotations`?**

<details>
<summary>Answer</summary>

`nico-dns.externalService.perPodAnnotations` (a list: `[0]` and `[1]`)

The Quick Start says to use `perPodAnnotations` because each replica gets its own VIP. A single `annotations` map would give one address for the whole service.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md)

<a id="kubernetes"></a>
## 2. Kubernetes

*Builds on: Containers and container images (ch. 2)*

### Before you read

- You've run containers with `docker run`. What would you have to build yourself to keep 3 copies of a container running across 3 servers, restarting them when a server dies?
- Does NICo install the Kubernetes cluster it runs on?

<details>
<summary>Answers</summary>

- **You've run containers with `docker run`. What would you have to build yourself to keep 3 copies of a container running across 3 servers, restarting them when a server dies?** A scheduler to place containers on servers, health monitoring, automatic restarts and rescheduling, service discovery and stable networking. Kubernetes provides all of these.
- **Does NICo install the Kubernetes cluster it runs on?** No. Operators provision their own cluster (with kubeadm, Kubespray, managed Kubernetes and so on) that meets NICo's requirements: v1.30 or later and at least three schedulable nodes.

</details>

### Explanation

**Kubernetes** is a container orchestration platform. You describe the *desired state* ("run 3 copies of this image, reachable on port 443"), and Kubernetes keeps working to make the cluster's *actual state* match. Nodes die, containers crash and images get upgraded, and through all of it Kubernetes keeps reconciling. If that sounds like NICo's own design, where API handlers record desired state and state machines drive the hardware toward it (Chapters 4–5), that's because it is the same pattern.

Key terms:

- **Cluster**: a set of machines managed together.
- **Node**: one machine in the cluster. Each node runs a **kubelet** agent and a container runtime such as **containerd**.
- **Control plane**: the components that store desired state and make decisions. The **API server** is the front door, and everything, including you, talks to it.
- **kubectl**: the command-line client for the API server. It reads a **kubeconfig** file (`$KUBECONFIG` or `~/.kube/config`) to find the cluster and your credentials.
- **Namespace**: a named partition of the cluster. NICo uses `nico-system`, `nico-rest`, `temporal`, `postgres`, `metallb-system` and others.
- **CNI**: the plugin that gives pods networking. The validated choice is Calico (Chapter 15).

NICo needs any conformant **Kubernetes v1.30+**. It is validated on v1.30.4 with containerd 1.7.1 on Ubuntu 24.04. The cluster needs **at least three schedulable nodes** (Ready, and not tainted NoSchedule/NoExecute) for high availability of PostgreSQL and Vault. Every node needs `net.ipv4.ip_forward=1` and `net.bridge.bridge-nf-call-iptables=1`, and must resolve `kubernetes.default.svc.cluster.local`. NICo does **not** provision the cluster; you bring it. `setup.sh` then runs from your workstation using `kubectl`, `helm` and `helmfile`.

For learning, **kind** runs each Kubernetes "node" as a Docker container on your laptop. It is real Kubernetes, with the same API and the same `kubectl`.

**Analogy.** Kubernetes is like a building's thermostat. You set the temperature you want, and the system keeps switching the heating on and off to hold it. You don't flip the boiler yourself. Where it breaks down: a thermostat controls one number, while Kubernetes reconciles thousands of objects of many kinds. It also can't fix a problem it has no way to act on. If an image doesn't exist, it will keep retrying and report an error.

### Worked example: Create a cluster and watch Kubernetes repair itself

**Step 1: Install the tools.**

Install Docker (or Podman), `kubectl` and `kind`:
```bash
# macOS
brew install kubectl kind
# Linux (amd64)
curl -Lo kind https://kind.sigs.k8s.io/dl/latest/kind-linux-amd64 && chmod +x kind && sudo mv kind /usr/local/bin/
```
On Linux, install `kubectl` the way the Quick Start shows (`snap install kubectl --classic` or the official binary).

**Step 2: Create a multi-node cluster.**

```bash
cat > kind-3.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF
kind create cluster --name lab --config kind-3.yaml
kubectl get nodes -o wide
```
Wait until all three nodes show `Ready`. `kubectl version` prints the server version, which must be v1.30 or later for NICo. It also prints your client version. Keep kubectl within one minor version of the server, because that is the version skew Kubernetes supports.

**Step 3: Declare desired state.**

```bash
kubectl create deployment hello --image=nginx --replicas=3
kubectl get pods -o wide
```
You asked for 3 copies, and the scheduler spreads them across the nodes.

**Step 4: Break something and watch it reconcile.**

```bash
kubectl delete pod $(kubectl get pods -l app=hello -o jsonpath='{.items[0].metadata.name}')
kubectl get pods -l app=hello
```
Within seconds a new pod with a different name appears. Kubernetes saw 2 running where 3 were desired and fixed it.

**Step 5: Look around the namespaces.**

```bash
kubectl get namespaces
kubectl get pods -n kube-system
```
The cluster's own components (CoreDNS, kube-proxy, the CNI) run as pods too. On a NICo site you'd run `kubectl get pods -n nico-system` the same way.

### Your turn: finish it

Complete this kind config so the cluster has one control-plane node and two worker nodes, matching the worked example.

```text
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: ___
  - role: ___
```

<details>
<summary>Answer</summary>

Both blanks are `worker`:
```yaml
  - role: worker
  - role: worker
```

</details>

### Your turn: on your own

You've been given a kubeconfig for a cluster and asked whether it meets NICo's basic Kubernetes requirements. Which `kubectl` commands do you run, and what output do you need to see?

<details>
<summary>Hint 1</summary>

There are two headline requirements: a version and a node count.

</details>

<details>
<summary>Hint 2</summary>

One command reports the server version; another lists nodes with their status.

</details>

<details>
<summary>Hint 3</summary>

Also check for NoSchedule/NoExecute taints: `kubectl describe nodes | grep -i taint`.

</details>

<details>
<summary>Answer</summary>

Run `export KUBECONFIG=/path/to/kubeconfig`, then `kubectl version` (Server Version must be v1.30 or later) and `kubectl get nodes` (at least three nodes with STATUS `Ready`). Then run `kubectl describe nodes | grep -i taints` to confirm that at least three nodes are schedulable, meaning not tainted NoSchedule/NoExecute. NICo's `preflight.sh` checks the same things and more, including kernel parameters and DNS on each node.

</details>

### Explain it

In your own words: Explain why the "declare desired state, let a controller reconcile" model suits a control plane like NICo's better than a script that starts containers once. Use the example of a node failing at 3 a.m.

### Check

**1. What is the minimum Kubernetes version NICo supports?**

A. v1.26
B. v1.30
C. v1.28
D. Any version, because NICo ships its own Kubernetes

<details>
<summary>Answer</summary>

**B.** v1.30

The docs say "any conformant Kubernetes v1.30+". 1.26 is the minimum *kubectl* client version in the tools table, which is a common mix-up. NICo does not ship or provision Kubernetes.

</details>

**2. Why does NICo need at least three schedulable nodes?**

A. kubectl only works with three or more nodes
B. For high availability of PostgreSQL and (unless --skip-vault) Vault
C. Because MetalLB needs exactly three BGP peers
D. Kubernetes refuses to start with fewer nodes

<details>
<summary>Answer</summary>

**B.** For high availability of PostgreSQL and (unless --skip-vault) Vault

The Quick Start ties the three-node minimum to HA PostgreSQL and Vault. Kubernetes runs fine on one node, which is how kind works by default. The number of MetalLB peers depends on your topology.

</details>

**3. A pod you never deleted has a new name and a recent start time. What most likely happened?**

A. Someone manually recreated it
B. A controller replaced it to keep actual state matching desired state
C. Kubernetes renames pods every hour
D. The container image was rebuilt

<details>
<summary>Answer</summary>

**B.** A controller replaced it to keep actual state matching desired state

Controllers such as Deployments replace pods that crashed or were evicted, and the replacements get new names (StatefulSet pods are the exception). Kubernetes doesn't rename pods on a timer, and rebuilding an image doesn't touch running pods.

</details>

**Sources:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md)

<a id="kubernetes-workload-and-config-objects"></a>
## 3. Kubernetes workload and config objects

*Builds on: Kubernetes (ch. 14)*

### Before you read

- NICo's built-in NTP service runs three chrony replicas, and each gets its own VIP. Why would a "pick any 3 interchangeable copies" deployment be a poor fit?
- `setup.sh` registers the site by running a bootstrap task once. What kind of object would you use for "run to completion, then stop"?

<details>
<summary>Answers</summary>

- **NICo's built-in NTP service runs three chrony replicas, and each gets its own VIP. Why would a "pick any 3 interchangeable copies" deployment be a poor fit?** Each replica needs a stable, distinct identity (name 0, 1, 2) so a specific VIP can stay attached to a specific replica. A StatefulSet provides that. Interchangeable copies get random names.
- **`setup.sh` registers the site by running a bootstrap task once. What kind of object would you use for "run to completion, then stop"?** A Job.

</details>

### Explanation

Everything in Kubernetes is an **object**. An object is a YAML document with `apiVersion`, `kind`, `metadata` (name, namespace, labels) and usually `spec` (the desired state). The cluster adds `status` (the actual state). You create objects with `kubectl apply -f file.yaml`. These are the ones the NICo docs mention constantly:

- **Pod**: the smallest unit. It holds one or more containers that share a network identity (one pod IP) and can share volumes. Pods are disposable.
- **Deployment**: keeps N interchangeable pod replicas running and handles rolling upgrades. `nico-api` runs as one (`kubectl logs deployment/nico-api`).
- **StatefulSet**: like a Deployment, but each replica has a **stable identity**, with names `name-0`, `name-1` and so on. If the StatefulSet defines `volumeClaimTemplates`, each replica also gets its own PersistentVolumeClaim. StatefulSets are used for replicated stateful apps such as PostgreSQL, Vault, Loki and the site-agent, and for `nico-ntp`, where each of the 3 replicas gets its own VIP.
- **Job**: runs pods until they finish successfully, for one-off tasks. For example, NICo's REST install (`setup.sh` Phase 7g) uses the `nico-rest-site-agent` bootstrap Job to register the site. The Quick Start's overall health check also lists Jobs with `kubectl get jobs -n nico-system`.
- **ConfigMap**: non-sensitive configuration, stored as key/value data or whole files. NICo's site TOML is rendered into the `nico-api` ConfigMap.
- **Secret**: like a ConfigMap but for sensitive data such as passwords, keys and registry credentials. Secrets get their own lesson later in this chapter.
- **Service**: a stable network name and address in front of a changing set of pods, chosen by **label selector**. Services also get their own lesson.

Pods consume ConfigMaps and Secrets as **environment variables** or as **files in a mounted volume**. Labels such as `app: nico-api` are how Services, Deployments and `kubectl -l` find pods. For example, the Quick Start runs `kubectl logs -n nico-system -l app.kubernetes.io/name=nico-dhcp`.

**Analogy.** Think of a restaurant. Pods are the cooks, and you can swap one for another. A Deployment is "always keep three line cooks on shift". A StatefulSet is assigned stations: "station 0 is grill, station 1 is pastry", and if you set it up that way, each station has its own fridge (volume). A Job is the caterer hired for one event. ConfigMaps are the recipe book, and Secrets are the safe combination. Where it breaks down: real cooks remember what they were doing, but a replaced Pod starts from scratch unless its state lives in a volume.

### Worked example: A ConfigMap, a Job that reads it, and a StatefulSet with stable names

**Step 1: Create a ConfigMap holding a TOML file.**

```bash
cat > site.toml <<'EOF'
sitename = "mysite"
initial_domain_name = "mysite.example.com"
EOF
kubectl create namespace demo
kubectl -n demo create configmap site-config --from-file=site.toml
kubectl -n demo get configmap site-config -o yaml
```

**Step 2: Run a Job that mounts it.**

```bash
cat > job.yaml <<'EOF'
apiVersion: batch/v1
kind: Job
metadata:
  name: read-config
  namespace: demo
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: reader
          image: busybox:1.36
          command: ["sh", "-c", "cat /config/site.toml"]
          volumeMounts:
            - name: cfg
              mountPath: /config
      volumes:
        - name: cfg
          configMap:
            name: site-config
EOF
kubectl apply -f job.yaml
kubectl -n demo wait --for=condition=complete job/read-config --timeout=120s
kubectl -n demo logs job/read-config
```
The logs print the same file you put into the ConfigMap. `kubectl get jobs -n demo` shows `COMPLETIONS 1/1`.

**Step 3: Create a StatefulSet and note the names.**

```bash
cat > sts.yaml <<'EOF'
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ntp
  namespace: demo
spec:
  serviceName: ntp
  replicas: 3
  selector:
    matchLabels:
      app: ntp
  template:
    metadata:
      labels:
        app: ntp
    spec:
      containers:
        - name: c
          image: busybox:1.36
          command: ["sh", "-c", "sleep 3600"]
EOF
kubectl apply -f sts.yaml
kubectl -n demo get pods -l app=ntp
```
The pods are named `ntp-0`, `ntp-1` and `ntp-2`, and they are created in order. This StatefulSet has no `volumeClaimTemplates`, so the replicas have stable names but no per-replica storage. The storage lesson adds that.

**Step 4: Prove the identity is stable.**

```bash
kubectl -n demo delete pod ntp-1
kubectl -n demo get pods -l app=ntp
```
The replacement is named `ntp-1` again. Compare that with the Deployment in the previous lesson, where the replacement got a random name. Stable names are what let `perPodAnnotations[1]` keep the same VIP on the same replica.

### Your turn: finish it

Complete this manifest for a one-off database-seeding task that should run once and not be restarted in place when it finishes.

```text
apiVersion: batch/v1
kind: ___
metadata:
  name: seed-db
spec:
  template:
    spec:
      restartPolicy: ___
      containers:
        - name: seed
          image: busybox:1.36
          command: ["sh", "-c", "echo seeding; sleep 2; echo done"]
```

<details>
<summary>Answer</summary>

`kind: Job` and `restartPolicy: Never`. `OnFailure` is also valid for Jobs. `Always`, the Pod default, is rejected for Jobs.

</details>

### Your turn: on your own

For each item, name the object type you'd use and say why: (a) NICo's `site.toml`; (b) the PostgreSQL database password; (c) a 3-node PostgreSQL cluster where each member keeps its own data; (d) the API server, where any replica can serve any request; (e) a stable name other pods use to reach the API.

<details>
<summary>Hint 1</summary>

Split the list into config objects and workload objects.

</details>

<details>
<summary>Hint 2</summary>

Ask: is it sensitive? Does it need a stable identity? Does it run to completion?

</details>

<details>
<summary>Hint 3</summary>

(c) needs per-replica identity and storage; (d) needs interchangeable replicas; (e) isn't a workload at all.

</details>

<details>
<summary>Answer</summary>

(a) ConfigMap: non-sensitive configuration, mounted as a file. (b) Secret: it is sensitive. NICo's DB credentials arrive as Secrets such as `nico-system.nico.nico-pg-cluster.credentials`. (c) StatefulSet with `volumeClaimTemplates`: stable names plus a PVC per replica. (d) Deployment: interchangeable replicas, like `deployment/nico-api`. (e) Service: a stable name and IP in front of pods selected by label.

</details>

### Explain it

In your own words: Why does Kubernetes keep configuration (ConfigMaps and Secrets) separate from workloads (Pods, Deployments, StatefulSets), instead of baking `site.toml` into the container image? Think about how NICo builds one set of images (Chapter 13) and deploys it to many sites.

### Check

**1. The NICo site-agent bootstrap runs once to register the site and then finishes. Which object fits?**

A. Deployment
B. StatefulSet
C. Job
D. ConfigMap

<details>
<summary>Answer</summary>

**C.** Job

Jobs run to completion. A Deployment or StatefulSet would keep restarting the task after it finished. A ConfigMap holds data and runs nothing.

</details>

**2. Why is `nico-ntp` a StatefulSet rather than a Deployment?**

A. StatefulSets are faster
B. Each replica needs a stable identity so a specific VIP stays attached to it
C. Deployments can't run chrony
D. StatefulSets don't need container images

<details>
<summary>Answer</summary>

**B.** Each replica needs a stable identity so a specific VIP stays attached to it

StatefulSet pods keep their names (`-0`, `-1`, `-2`) across restarts, which suits per-pod VIPs. Speed isn't the difference, and both object types run ordinary container images.

</details>

**3. How does a Service know which pods to send traffic to?**

A. By pod name
B. By label selector
C. By the node the pods run on
D. By container image tag

<details>
<summary>Answer</summary>

**B.** By label selector

A Service selects the pods whose labels match its selector. Pod names change, and nodes and image tags aren't used for selection.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md), [getting-started/installation-options/day0-credential-store.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-credential-store.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md)

<a id="kubernetes-custom-resource"></a>
## 4. Kubernetes Custom Resource (CR/CRD)

*Builds on: Kubernetes workload and config objects (ch. 14)*

### Before you read

- The Quick Start runs `kubectl get ipaddresspool,bgppeer -n metallb-system`. Plain Kubernetes has no object called IPAddressPool. Where do you think it comes from?
- If you create one of these custom objects but the software that understands it isn't running, what happens?

<details>
<summary>Answers</summary>

- **The Quick Start runs `kubectl get ipaddresspool,bgppeer -n metallb-system`. Plain Kubernetes has no object called IPAddressPool. Where do you think it comes from?** MetalLB installs a CustomResourceDefinition that adds these types to the Kubernetes API, and MetalLB's controller acts on them.
- **If you create one of these custom objects but the software that understands it isn't running, what happens?** The object is stored and you can `get` it, but nothing acts on it. Nothing in the real world changes, because no operator is reconciling it.

</details>

### Explanation

The Kubernetes API can be extended. A **CustomResourceDefinition (CRD)** registers a new object type with a group, a version, a kind and a schema. After that, the API server accepts **Custom Resources (CRs)** of that kind, and you can `kubectl get`, `apply` and `delete` them just like Pods.

A CRD only teaches Kubernetes to *store and validate* the new objects. To make them *do* something you need an **operator** (also called a controller). An operator is a program, usually running as a pod, that watches those CRs and reconciles them into real state. It is the same desired-state loop from the Kubernetes lesson, applied to a new domain.

You'll meet many CRs on a NICo site:

- **MetalLB**: `IPAddressPool`, `BGPPeer`, `BGPAdvertisement`, `L2Advertisement`. The MetalLB controller turns them into VIP allocation and announcements.
- **cert-manager**: `ClusterIssuer` (`site-issuer`, `vault-nico-issuer`) and `Certificate`. cert-manager turns these into real TLS certificates stored in Secrets.
- **External Secrets Operator**: `ClusterSecretStore` and `ExternalSecret`, which copy credentials into Secrets in each namespace.
- **Zalando Postgres Operator**: a postgres cluster CR (`nico-pg-cluster`) that becomes a StatefulSet, Services and credentials.
- **DPF** (Chapter 36): `DPUDeployment`, `DPUFlavor` and `BFB`, which describe how DPUs should be provisioned.

CRDs are cluster-scoped and named `<plural>.<group>`, for example `ipaddresspools.metallb.io`. Each CR is either namespaced or cluster-scoped, depending on what its CRD says. `kubectl get crd` lists every extension installed in a cluster, which is a quick way to see which operators are present.

**Analogy.** A CRD is like adding a new form type to a government office: "Form DPU-7, fields: model, firmware". The clerks will now accept and file it. The operator is the department that actually processes Form DPU-7. Where it breaks down: a real office would probably reject a form nobody handles, but Kubernetes will happily store a CR that no operator handles. That silent inaction is the failure mode to watch for.

### Worked example: Define a Rack type, create racks, and see schema validation

**Step 1: Write and apply the CRD.**

```bash
cat > rack-crd.yaml <<'EOF'
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: racks.lab.example.com
spec:
  group: lab.example.com
  scope: Namespaced
  names:
    plural: racks
    singular: rack
    kind: Rack
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                location:
                  type: string
                hosts:
                  type: integer
EOF
kubectl apply -f rack-crd.yaml
kubectl wait --for=condition=Established crd/racks.lab.example.com --timeout=60s
```

**Step 2: Create a custom resource.**

```bash
cat > rack-a.yaml <<'EOF'
apiVersion: lab.example.com/v1
kind: Rack
metadata:
  name: rack-a01
  namespace: default
spec:
  location: row-a
  hosts: 18
EOF
kubectl apply -f rack-a.yaml
kubectl get racks
kubectl get rack rack-a01 -o yaml
```

**Step 3: See validation reject bad data.**

```bash
kubectl patch rack rack-a01 --type=merge -p '{"spec":{"hosts":"many"}}'
```
The API server rejects it with an error saying `spec.hosts` must be an integer. The schema is enforced even though no operator exists.

**Step 4: Notice what is missing.**

Nothing powers on 18 hosts in row A. With no operator watching `racks`, the CR is just stored data. On a NICo site, `kubectl get pods -n metallb-system` shows the controller that makes `IPAddressPool` objects actually do something.

**Step 5: List real CRDs.**

```bash
kubectl get crd
```
kind ships only a few. On a NICo site you'd see `ipaddresspools.metallb.io`, `certificates.cert-manager.io`, `externalsecrets.external-secrets.io` and many more.

### Your turn: finish it

Complete this CRD for a `Switch` type in group `lab.example.com`, plus one instance. Fill in the CRD's name and the instance's kind.

```text
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: ___
spec:
  group: lab.example.com
  scope: Namespaced
  names:
    plural: switches
    singular: switch
    kind: Switch
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          x-kubernetes-preserve-unknown-fields: true
---
apiVersion: lab.example.com/v1
kind: ___
metadata:
  name: tor-a01
  namespace: default
```

<details>
<summary>Answer</summary>

`name: switches.lab.example.com` (CRD names are always `<plural>.<group>`) and `kind: Switch`. If you apply both documents at once, the second may fail the first time because the CRD isn't registered yet. Run `kubectl apply` again, or apply the CRD first and wait for it to be Established.

</details>

### Your turn: on your own

After an install, `kubectl get ipaddresspool -n metallb-system` lists your pools, but every LoadBalancer Service in `nico-system` still shows `<pending>`. Using what you know about CRs and operators, list the first things you'd check.

<details>
<summary>Hint 1</summary>

A CR existing is not the same as a CR being acted on.

</details>

<details>
<summary>Hint 2</summary>

Which pods turn MetalLB CRs into real behaviour?

</details>

<details>
<summary>Hint 3</summary>

The Quick Start says to check BGP session status on the ToRs and the peer addresses in `metallb-config.yaml`. The preflight also checks that exactly one advertisement mode is active.

</details>

<details>
<summary>Answer</summary>

(1) Check that the operator is running: `kubectl get pods -n metallb-system` should show the controller and speaker as Running. Then read their logs. (2) Check that the CRs are complete and correct. The pools must contain the VIPs you annotated, an advertisement must exist (BGP *or* L2, not both), BGPPeer addresses and ASNs must match the ToRs, and node selectors must match real hostnames (`kubectl get bgppeer -n metallb-system -o yaml`). (3) Check the ToR side for established BGP sessions. A CR with no operator, or one the operator can't satisfy, leaves Services pending.

</details>

### Explain it

In your own words: Explain the difference between a CRD, a CR and an operator, and why a CR with no operator is "valid but does nothing". Why might Kubernetes be designed to accept it anyway?

### Check

**1. You apply a CR whose CRD is installed but whose operator is not running. What happens?**

A. The API server rejects it
B. It is stored and visible with kubectl get, but nothing reconciles it
C. Kubernetes reconciles it itself
D. The CRD is deleted

<details>
<summary>Answer</summary>

**B.** It is stored and visible with kubectl get, but nothing reconciles it

The API server stores and schema-validates CRs. Reconciling them is the operator's job, because core Kubernetes doesn't know what an IPAddressPool means.

</details>

**2. Which of these is a custom resource on a NICo site, not a built-in Kubernetes type?**

A. ConfigMap
B. StatefulSet
C. ClusterIssuer
D. Service

<details>
<summary>Answer</summary>

**C.** ClusterIssuer

ClusterIssuer comes from cert-manager's CRDs. The other three are built-in types.

</details>

**3. What is the required metadata.name of a CRD whose plural is `dpuflavors` in group `example.com`?**

<details>
<summary>Answer</summary>

`dpuflavors.example.com`

CRD names must be `<plural>.<group>`. Using the kind (`DPUFlavor`) or the singular is a common mistake, and the API server rejects it.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md)

<a id="kubernetes-service-types"></a>
## 5. Kubernetes Service types (LoadBalancer, NodePort, ClusterIP)

*Builds on: Kubernetes workload and config objects (ch. 14)*

### Before you read

- NICo's PostgreSQL is only ever used by `nico-api` and other pods in the cluster. Should it be reachable from the datacenter network?
- On a bare-metal cluster with no cloud provider, what do you think a Service of type LoadBalancer shows as its external IP?

<details>
<summary>Answers</summary>

- **NICo's PostgreSQL is only ever used by `nico-api` and other pods in the cluster. Should it be reachable from the datacenter network?** No. It is exposed as a ClusterIP Service on port 5432, which is reachable only from inside the cluster.
- **On a bare-metal cluster with no cloud provider, what do you think a Service of type LoadBalancer shows as its external IP?** `<pending>`, until something like MetalLB provides an IP. That is exactly what the Quick Start warns about.

</details>

### Explanation

A **Service** gives a stable name and IP to the set of pods that match its selector. Kubernetes DNS makes it resolvable as `<name>.<namespace>.svc.cluster.local`, for example `temporal-frontend.temporal.svc:7233` or `vault.vault.svc:8200`. The Service's **type** decides who can reach it:

- **ClusterIP** (the default): a virtual IP reachable **only from inside the cluster**. It suits internal dependencies. The docs expose PostgreSQL as a ClusterIP Service on port `5432`.
- **NodePort**: everything ClusterIP does, plus a port opened on **every node's IP**, by default in the range 30000–32767. Traffic to `<any-node-ip>:<nodePort>` reaches the pods. By default, `setup.sh` exposes `nico-rest-api` through a NodePort. It's simple, but clients need to know a node IP and a high port.
- **LoadBalancer**: everything NodePort does, plus an **external IP** supplied by a load-balancer implementation. In a public cloud, the cloud provides it. On bare metal nothing provides it by default, so **MetalLB** fills the gap: it assigns a VIP from your `IPAddressPool` and advertises it (L2 or BGP, Chapter 15). The Quick Start notes that without MetalLB, NICo Core services "stay in `<pending>` state and the site is unreachable".

The NICo Core services that must be reachable from outside (`nico-api`, `nico-dhcp`, `nico-dns`, `nico-pxe`, `nico-ssh-console-rs`) use LoadBalancer, each with a pinned VIP as in the first lesson. Contour's Envoy is also a LoadBalancer and takes its IP from the external pool. Some charts let you change `externalService.type` to `NodePort` or `ClusterIP`, and those types don't need VIPs. The DHCPv6 external Service is always LoadBalancer.

To see what was assigned, run `kubectl get svc -n nico-system` and read the `TYPE`, `CLUSTER-IP`, `EXTERNAL-IP` and `PORT(S)` columns.

**Analogy.** Think of an office building. ClusterIP is an internal extension: only people inside the building can dial it. NodePort means every entrance has a side door numbered 30080 that leads to the same desk. LoadBalancer is a published street address with a receptionist who directs visitors, and MetalLB is the city office that hands out that address. Where it breaks down: a building has one location, but a Service's pods can be spread across many nodes and move between them.

### Worked example: Expose one app three ways on kind

**Step 1: Deploy an app.**

```bash
kubectl create namespace svc-demo
kubectl -n svc-demo create deployment web --image=nginx --replicas=2
kubectl -n svc-demo rollout status deployment/web
```

**Step 2: ClusterIP: reachable from inside only.**

```bash
kubectl -n svc-demo expose deployment web --name=web-cip --port=80
kubectl -n svc-demo get svc web-cip
kubectl run tmp -n svc-demo --rm -i --quiet --restart=Never --image=curlimages/curl -- \
  -s -o /dev/null -w '%{http_code}\n' http://web-cip.svc-demo.svc.cluster.local
# 200
```
The CLUSTER-IP (for example 10.96.x.x) isn't routable from your laptop.

**Step 3: NodePort: a port on every node.**

```bash
kubectl -n svc-demo expose deployment web --name=web-np --type=NodePort --port=80
kubectl -n svc-demo get svc web-np          # PORT(S) shows 80:3xxxx/TCP
NP=$(kubectl -n svc-demo get svc web-np -o jsonpath='{.spec.ports[0].nodePort}')
NODE=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
kubectl run tmp -n svc-demo --rm -i --quiet --restart=Never --image=curlimages/curl -- \
  -s -o /dev/null -w '%{http_code}\n' http://$NODE:$NP
# 200
```
Try another node's InternalIP and it works too.

**Step 4: LoadBalancer: see <pending>.**

```bash
kubectl -n svc-demo expose deployment web --name=web-lb --type=LoadBalancer --port=80
kubectl -n svc-demo get svc web-lb
# EXTERNAL-IP   <pending>
```
kind has no load-balancer implementation, so nothing assigns an IP. A NICo site whose MetalLB is missing or misconfigured shows the same symptom. The LoadBalancer Service still received a NodePort, because each type builds on the one before it.

### Your turn: finish it

Complete this Service so the pods labelled `app: web` are reachable on port 30080 of every node.

```text
apiVersion: v1
kind: Service
metadata:
  name: web-fixed-np
  namespace: svc-demo
spec:
  type: ___
  selector:
    app: web
  ports:
    - port: 80
      targetPort: 80
      nodePort: ___
```

<details>
<summary>Answer</summary>

`type: NodePort` and `nodePort: 30080`. 30080 is inside the default range of 30000–32767; values outside that range are rejected.

</details>

### Your turn: on your own

For each NICo-related endpoint, pick a Service type and justify it: (a) PostgreSQL used only by nico-api; (b) nico-dhcp, which receives relayed requests from OOB switches; (c) a quick lab exposure of nico-rest-api without DNS or TLS; (d) Contour's Envoy serving `https://rest-api.mysite.example.com`.

<details>
<summary>Hint 1</summary>

Who are the clients: pods in the cluster, or devices on the datacenter network?

</details>

<details>
<summary>Hint 2</summary>

Does the client need a stable, well-known address and a normal port (DHCP uses port 67)?

</details>

<details>
<summary>Hint 3</summary>

From the docs: Postgres uses ClusterIP on 5432, REST defaults to NodePort, NICo Core services use LoadBalancer VIPs, and Envoy is a LoadBalancer from vip-pool-external.

</details>

<details>
<summary>Answer</summary>

(a) ClusterIP: the only clients are inside the cluster, and the docs specify a ClusterIP on 5432. (b) LoadBalancer with a pinned internal-pool VIP: switches relay to one fixed address on the standard DHCP port, so a NodePort's high port and per-node IPs won't work. (c) NodePort: this is the default for nico-rest-api in `setup.sh`, and it is easy for a lab. (d) LoadBalancer: the DNS A record must point at a stable external IP, which MetalLB assigns from `vip-pool-external`.

</details>

### Explain it

In your own words: Explain why a LoadBalancer Service on bare metal shows `<pending>`, while the same manifest gets an IP immediately in a public cloud. What exactly does MetalLB contribute?

### Check

**1. `kubectl get svc -n nico-system` shows `nico-dhcp` with EXTERNAL-IP `<pending>`. What is the most likely cause?**

A. The DHCP pods crashed
B. No load-balancer implementation (MetalLB) assigned an IP: it isn't running, the pool is wrong, or the requested VIP is outside the pool
C. The Service should be ClusterIP
D. DNS is broken

<details>
<summary>Answer</summary>

**B.** No load-balancer implementation (MetalLB) assigned an IP: it isn't running, the pool is wrong, or the requested VIP is outside the pool

EXTERNAL-IP is filled in by the load-balancer implementation, whatever the state of the pods. A Service gets its address even if its pods are down. Changing the type to ClusterIP would make DHCP unreachable from the switches.

</details>

**2. Which type is reachable only from inside the cluster?**

A. NodePort
B. LoadBalancer
C. ClusterIP
D. All of them

<details>
<summary>Answer</summary>

**C.** ClusterIP

NodePort and LoadBalancer add external exposure on top of the ClusterIP that all of them have.

</details>

**3. Why is NodePort a poor fit for nico-dhcp?**

A. NodePort doesn't support UDP
B. Clients must target a node IP and a high port, and neither the node nor the port is a stable, standard DHCP endpoint
C. NodePort Services can't select pods
D. NodePort costs money

<details>
<summary>Answer</summary>

**B.** Clients must target a node IP and a high port, and neither the node nor the port is a stable, standard DHCP endpoint

NodePort does support UDP, so that isn't the problem. Relays need one well-known address on the standard port that survives a node failure, which is what a VIP gives you.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md)

<a id="persistent-storage"></a>
## 6. Persistent storage (StorageClass, PVC, local-path-provisioner)

*Builds on: Kubernetes workload and config objects (ch. 14)*

### Before you read

- A PostgreSQL pod is deleted and recreated on a fresh container filesystem. What happens to the database if nothing else is configured?
- NICo's reference install doesn't need SAN/NAS or Ceph. Where do you think the PostgreSQL and Vault data actually lives?

<details>
<summary>Answers</summary>

- **A PostgreSQL pod is deleted and recreated on a fresh container filesystem. What happens to the database if nothing else is configured?** It's gone. A container's filesystem is ephemeral, so durable data needs a persistent volume that outlives the pod.
- **NICo's reference install doesn't need SAN/NAS or Ceph. Where do you think the PostgreSQL and Vault data actually lives?** On each node's local NVMe disk, in volumes created by local-path-provisioner.

</details>

### Explanation

Pods are disposable, so anything written inside a container disappears when the pod is replaced. Kubernetes separates *asking for* storage from *providing* it:

- **PersistentVolume (PV)**: an actual piece of storage, such as a directory on a node's disk, a cloud disk or a SAN LUN.
- **PersistentVolumeClaim (PVC)**: a pod's request for storage, for example "10Gi, ReadWriteOnce". Pods mount PVCs, never PVs directly.
- **StorageClass**: a named recipe for creating PVs on demand. When a PVC names a StorageClass, that class's **provisioner** creates a matching PV automatically. This is called *dynamic provisioning*.

**local-path-provisioner** is a simple provisioner. It creates each PV as a directory on the local disk of the node where the pod is scheduled. That is fast and needs no shared storage, but the data lives on **one node**. The pod is effectively pinned to that node, and if the node's disk dies, that copy is lost. So the applications provide their own redundancy. That is why NICo runs three PostgreSQL instances with three 10Gi `pgdata` PVs, and Vault with three `data-vault` and three `audit-vault` 10GB PVs, "in the absence of a shared storage solution". Loki uses a single 50GB PV.

In NICo's `setup.sh`, **Phase 1** installs local-path-provisioner and its StorageClasses before anything else, because the PostgreSQL and Vault claims depend on them. The `volumeSize: "10Gi"` setting for PostgreSQL in `values.yaml` sets the claim size.

StatefulSets request storage through **volumeClaimTemplates**, which create one PVC per replica named `<template>-<statefulset>-<ordinal>`. A replacement `pg-1` pod reattaches to its own PVC. By default, deleting a StatefulSet does **not** delete those PVCs, which protects your data. You delete them yourself, or delete the whole namespace.

A separate fact: when a PVC is deleted, its PV's **reclaim policy** decides what happens next. `Delete` removes the PV and its data. `Retain` keeps the PV in a **Released** state. NICo's teardown script `clean.sh` removes the namespaces, which deletes the PVCs in them, and then cleans up any released PersistentVolumes left behind.

kind ships local-path-provisioner as its default StorageClass, `standard`, so you can try all of this on a laptop.

**Analogy.** A PVC is a hotel booking ("one double room, two nights"), a PV is the actual room, and the StorageClass is the hotel chain's rule for where rooms come from. With local-path, your room is in one specific building. Your luggage stays safe while you go out (the pod restarts), but if that building floods, it's gone, and you can't check into a different building and find your luggage there. Where it breaks down: hotels clear the room at checkout, while a PV's reclaim policy decides whether the data is deleted or kept.

### Worked example: Prove data survives a pod being deleted

**Step 1: Inspect the StorageClass.**

```bash
kubectl get storageclass
# NAME                 PROVISIONER             ... VOLUMEBINDINGMODE
# standard (default)   rancher.io/local-path   ... WaitForFirstConsumer
```
`WaitForFirstConsumer` means a PVC stays `Pending` until a pod that uses it is scheduled. That way the volume can be created on that pod's node.

**Step 2: Create a claim and a pod that writes to it.**

```bash
kubectl create namespace pv-demo
cat > pv.yaml <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: notes
  namespace: pv-demo
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: standard
  resources:
    requests:
      storage: 100Mi
---
apiVersion: v1
kind: Pod
metadata:
  name: writer
  namespace: pv-demo
spec:
  containers:
    - name: c
      image: busybox:1.36
      command: ["sh", "-c", "date >> /data/boots.log; sleep 3600"]
      volumeMounts:
        - name: notes
          mountPath: /data
  volumes:
    - name: notes
      persistentVolumeClaim:
        claimName: notes
EOF
kubectl apply -f pv.yaml
kubectl -n pv-demo wait --for=condition=Ready pod/writer --timeout=120s
kubectl -n pv-demo get pvc,pv
```
The PVC is now `Bound` to an automatically created PV.

**Step 3: Delete and recreate the pod.**

```bash
kubectl -n pv-demo delete pod writer     # waits until the pod is gone
kubectl apply -f pv.yaml
kubectl -n pv-demo wait --for=condition=Ready pod/writer --timeout=120s
kubectl -n pv-demo exec writer -- cat /data/boots.log
```
The file has **two** timestamps. The first was written by the previous pod.

**Step 4: Find where the data physically lives.**

```bash
kubectl get pv -o jsonpath='{.items[0].spec.local.path}{.items[0].spec.hostPath.path}{"\n"}'
kubectl get pv -o jsonpath='{.items[0].spec.nodeAffinity}{"\n"}'
kubectl get pv -o jsonpath='{.items[0].spec.persistentVolumeReclaimPolicy}{"\n"}'
```
You'll see a directory path, a node affinity naming exactly one node (the "node-local" in local-path), and the reclaim policy, which is `Delete` for kind's `standard` class.

### Your turn: finish it

Complete this claim for a PostgreSQL member that should use the `standard` StorageClass and request the same size as NICo's default `volumeSize`.

```text
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pgdata-demo
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: ___
  resources:
    requests:
      storage: ___
```

<details>
<summary>Answer</summary>

`storageClassName: standard` and `storage: 10Gi`.

</details>

### Your turn: on your own

A StatefulSet named `vault` has two volumeClaimTemplates, `data` and `audit`, and 3 replicas. (a) Which PVC names will exist? (b) After `kubectl delete statefulset vault`, are they still there? (c) Why is local-path acceptable here even though each volume lives on one node?

<details>
<summary>Hint 1</summary>

The naming pattern is `<template>-<statefulset>-<ordinal>`.

</details>

<details>
<summary>Hint 2</summary>

Kubernetes is cautious with data when you delete a StatefulSet.

</details>

<details>
<summary>Hint 3</summary>

If storage doesn't provide redundancy, who does? Think about "HA Raft".

</details>

<details>
<summary>Answer</summary>

(a) `data-vault-0`, `data-vault-1`, `data-vault-2`, `audit-vault-0`, `audit-vault-1`, `audit-vault-2`. This matches the docs' three `data-vault` and three `audit-vault` PVs. (b) Yes. PVCs created from volumeClaimTemplates survive StatefulSet deletion by default, and you must delete them yourself (or delete the namespace) to free the storage. (c) Vault runs as a 3-node HA Raft cluster, so the application replicates data across nodes. Losing one node's disk loses only one replica.

</details>

### Explain it

In your own words: Explain why NICo can get away with node-local storage for PostgreSQL and Vault, and what the trade-off would be if it ran a single replica of each.

### Check

**1. Your new PVC on kind shows `Pending`, and no pod uses it yet. What's going on?**

A. The provisioner is broken
B. The StorageClass uses WaitForFirstConsumer, so the volume is created only once a pod using it is scheduled
C. PVCs always need a manually created PV
D. The cluster is out of disk

<details>
<summary>Answer</summary>

**B.** The StorageClass uses WaitForFirstConsumer, so the volume is created only once a pod using it is scheduled

This is expected for local-path, which needs to know the node before it can create the directory. With dynamic provisioning you don't create PVs by hand.

</details>

**2. Which setup.sh phase installs local-path-provisioner, and why that early?**

A. Phase 6, alongside NICo Core
B. Phase 1, because PostgreSQL and Vault volume claims depend on its StorageClasses
C. Phase 7, for REST
D. It's never installed; kind provides it

<details>
<summary>Answer</summary>

**B.** Phase 1, because PostgreSQL and Vault volume claims depend on its StorageClasses

The phase table lists local-path-provisioner and its StorageClasses as Phase 1. kind has its own copy, but a real NICo cluster gets it from setup.sh.

</details>

**3. What is the main risk of local-path volumes?**

A. They are slower than network storage
B. The data lives on one node's disk, so the pod is tied to that node and a disk failure loses that replica
C. They can't be larger than 1Gi
D. They are deleted on every pod restart

<details>
<summary>Answer</summary>

**B.** The data lives on one node's disk, so the pod is tied to that node and a disk failure loses that replica

Local NVMe is usually *faster* than network storage, and volumes survive pod restarts, as the worked example showed. The real risk is that each volume depends on a single node.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md)

<a id="kubernetes-rbac"></a>
## 7. Kubernetes RBAC

*Builds on: Kubernetes workload and config objects (ch. 14)*

### Before you read

- A pod in `nico-system` makes calls to the Kubernetes API. Whose identity is it using, and who decided what it may do?
- Should a pod that only needs to read ConfigMaps be able to read Secrets?

<details>
<summary>Answers</summary>

- **A pod in `nico-system` makes calls to the Kubernetes API. Whose identity is it using, and who decided what it may do?** It uses a ServiceAccount: its own, or `default` if none is set. RBAC Roles and bindings decide which verbs it may use on which resources.
- **Should a pod that only needs to read ConfigMaps be able to read Secrets?** No. That is least privilege: grant only the verbs and resources it needs.

</details>

### Explanation

Every request to the Kubernetes API server is made by some identity. Humans use credentials from their kubeconfig. Pods use a **ServiceAccount**, a namespaced identity that Kubernetes mounts into the pod as a token. If you don't set one, the pod uses its namespace's `default` ServiceAccount. Kubernetes **RBAC** (role-based access control) decides what each identity may do. It denies by default, so anything not granted is refused.

There are four object types:

- **Role**: a list of rules within **one namespace**. Each rule names API groups, resources (`pods`, `configmaps`, `secrets` and so on) and **verbs** (`get`, `list`, `watch`, `create`, `update`, `patch`, `delete`).
- **ClusterRole**: the same, but cluster-wide, or for cluster-scoped resources such as nodes and CRDs.
- **RoleBinding**: grants a Role, or a ClusterRole limited to the binding's namespace, to **subjects**: users, groups or ServiceAccounts.
- **ClusterRoleBinding**: grants a ClusterRole across the whole cluster.

The Role says *what* is allowed, and the binding says *who* gets it. `kubectl auth can-i` lets you test this without writing any code:

```bash
kubectl auth can-i list secrets -n demo --as=system:serviceaccount:demo:reader
```

Why this matters for NICo: operators like cert-manager, ESO, MetalLB and the Postgres operator all run under ServiceAccounts with ClusterRoles that let them watch their CRs and write Secrets or Services. Their Helm charts install these roles for you, and when one is missing you see `forbidden` errors in the operator's logs. ServiceAccount identity also reaches beyond Kubernetes. Vault's **Kubernetes auth** maps ServiceAccounts in `nico-system`, `cert-manager`, `cloud-api`, `cloud-workflow` and `elektra-site-agent` to Vault roles. That is Vault's own policy system (Chapter 20), not Kubernetes RBAC, but it relies on the same ServiceAccount tokens. The `--skip-vault` preflight even checks that `nico-api.automountServiceAccountToken` isn't `false`, because nico-api needs its token to request certificates through cert-manager.

**Analogy.** RBAC works like keycards in an office. The ServiceAccount is the employee badge, the Role is an access profile ("may open supply cupboards on floor 3"), and the RoleBinding links the badge to the profile. Where it breaks down: a keycard only opens doors, but RBAC is far more granular. It can allow `get` on a resource while denying `delete`, which no door lock can do.

### Worked example: Give a ServiceAccount read-only access to ConfigMaps

**Step 1: Create a namespace and ServiceAccount.**

```bash
kubectl create namespace rbac-demo
kubectl -n rbac-demo create serviceaccount reader
kubectl auth can-i list configmaps -n rbac-demo --as=system:serviceaccount:rbac-demo:reader
# no
```
By default, the new account can do nothing.

**Step 2: Write a Role and RoleBinding.**

```bash
cat > rbac.yaml <<'EOF'
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: configmap-reader
  namespace: rbac-demo
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: reader-can-read-configmaps
  namespace: rbac-demo
subjects:
  - kind: ServiceAccount
    name: reader
    namespace: rbac-demo
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: configmap-reader
EOF
kubectl apply -f rbac.yaml
```
`apiGroups: [""]` means the core API group, where ConfigMaps, Secrets and Pods live.

**Step 3: Test with kubectl auth can-i.**

```bash
SA=system:serviceaccount:rbac-demo:reader
kubectl auth can-i list configmaps -n rbac-demo --as=$SA   # yes
kubectl auth can-i delete configmaps -n rbac-demo --as=$SA # no
kubectl auth can-i list secrets -n rbac-demo --as=$SA      # no
kubectl auth can-i list configmaps -n default --as=$SA     # no (Role is namespaced)
```

**Step 4: Read the permissions back.**

```bash
kubectl -n rbac-demo describe rolebinding reader-can-read-configmaps
kubectl auth can-i --list -n rbac-demo --as=system:serviceaccount:rbac-demo:reader
```
When an operator on a NICo site logs `forbidden`, this is how you check what its ServiceAccount is actually allowed to do.

### Your turn: finish it

Complete this Role and RoleBinding so the ServiceAccount `job-watcher` in namespace `ops` can view (but not change) Jobs. Jobs are in the `batch` API group.

```text
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: job-viewer
  namespace: ops
rules:
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ___
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: job-watcher-views-jobs
  namespace: ops
subjects:
  - kind: ___
    name: job-watcher
    namespace: ops
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: job-viewer
```

<details>
<summary>Answer</summary>

`verbs: ["get", "list", "watch"]` and `kind: ServiceAccount`.

</details>

### Your turn: on your own

An in-house monitoring tool runs in namespace `monitor` and needs to list Pods in *every* namespace, including `nico-system` and `nico-rest`, but must not touch Secrets. Which RBAC objects do you create, and how do you prove it works?

<details>
<summary>Hint 1</summary>

"Every namespace" rules out a plain Role and RoleBinding.

</details>

<details>
<summary>Hint 2</summary>

You need a cluster-scoped role and a cluster-scoped binding to a ServiceAccount.

</details>

<details>
<summary>Hint 3</summary>

Verify with `kubectl auth can-i list pods -A --as=system:serviceaccount:monitor:<name>` and the same command for secrets.

</details>

<details>
<summary>Answer</summary>

Create a ServiceAccount `pod-lister` in `monitor`, a **ClusterRole** with `apiGroups: [""]`, `resources: ["pods"]` and `verbs: ["get","list","watch"]`, and a **ClusterRoleBinding** that grants it to that ServiceAccount. To verify, `kubectl auth can-i list pods -A --as=system:serviceaccount:monitor:pod-lister` should print yes, and `kubectl auth can-i list secrets -n nico-system --as=system:serviceaccount:monitor:pod-lister` should print no.

</details>

### Explain it

In your own words: Why does Kubernetes split "what is allowed" (Role) from "who is allowed" (RoleBinding) instead of attaching permissions directly to a ServiceAccount? Think about many NICo namespaces needing the same permission.

### Check

**1. A pod spec doesn't set `serviceAccountName`. Which identity does it use for API calls?**

A. The cluster admin
B. The `default` ServiceAccount in its namespace
C. No identity, so it can't call the API
D. The identity of whoever ran kubectl apply

<details>
<summary>Answer</summary>

**B.** The `default` ServiceAccount in its namespace

Every namespace has a `default` ServiceAccount, and pods use it unless told otherwise. Pods never inherit the permissions of the user who created them.

</details>

**2. You bind a Role in namespace `a` to a ServiceAccount. Can it read ConfigMaps in namespace `b`?**

A. Yes, Roles are global
B. No, a Role and RoleBinding apply only in their own namespace
C. Only if the ServiceAccount is also in `b`
D. Yes, if the verbs include list

<details>
<summary>Answer</summary>

**B.** No, a Role and RoleBinding apply only in their own namespace

Cross-namespace or cluster-wide access needs a ClusterRole plus a ClusterRoleBinding, or a RoleBinding in each namespace.

</details>

**3. Vault's Kubernetes auth maps NICo ServiceAccounts to Vault roles. Is that Kubernetes RBAC?**

A. Yes, it is a ClusterRoleBinding
B. No, it is Vault's own authorization, which uses the ServiceAccount token as proof of identity
C. Yes, Vault creates Roles in each namespace
D. No, Vault ignores ServiceAccounts

<details>
<summary>Answer</summary>

**B.** No, it is Vault's own authorization, which uses the ServiceAccount token as proof of identity

Kubernetes RBAC governs only the Kubernetes API. Vault checks the token and applies its own policies. They are two separate systems that share the same identity.

</details>

**Sources:** [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="kubernetes-secret"></a>
## 8. Kubernetes Secret

*Builds on: Kubernetes workload and config objects (ch. 14)*

### Before you read

- `kubectl get secret X -o yaml` shows `password: bmljby1wYXNz`. Is that encrypted?
- NICo images come from a private registry. How does a node's container runtime get the registry password when Kubernetes starts a pod?

<details>
<summary>Answers</summary>

- **`kubectl get secret X -o yaml` shows `password: bmljby1wYXNz`. Is that encrypted?** No. It's base64-encoded, and `echo bmljby1wYXNz | base64 -d` prints `nico-pass`. The protection comes from RBAC, and optionally from encryption at rest in etcd, not from the encoding.
- **NICo images come from a private registry. How does a node's container runtime get the registry password when Kubernetes starts a pod?** The pod (or its ServiceAccount) references an image pull Secret of type `kubernetes.io/dockerconfigjson` in the same namespace.

</details>

### Explanation

A **Secret** is a namespaced object for sensitive data such as passwords, tokens, keys, certificates and registry credentials. It looks like a ConfigMap, but the values under `data` are **base64-encoded**. You can also write plain text under `stringData`. Base64 is an encoding, not encryption. What actually protects a Secret is (a) RBAC, which controls who can `get` Secrets (previous lesson), (b) optional encryption at rest in the cluster's datastore, and (c) keeping the values out of Git and shell history.

Pods use Secrets in three common ways:

1. **Environment variable** through `secretKeyRef`. NICo's Day 0 guide exposes the credential KEK this way: `NICO_SECRETS_KEK` uses `valueFrom.secretKeyRef` to name the Secret `nico-secrets-kek` and the key `site-kek-1`. The site-agent gets `DB_USER` and `DB_PASSWORD` from the `db-creds` Secret.
2. **Mounted files**: each key becomes a file. TLS certificates are usually consumed this way.
3. **Image pull Secret**: type `kubernetes.io/dockerconfigjson`, listed under `imagePullSecrets`. The docs ask for an image pull secret (for example `imagepullsecret`) in each namespace that pulls from your registry. `setup.sh` builds one from `REGISTRY_PULL_USERNAME` (default `$oauthtoken`) and `REGISTRY_PULL_SECRET`.

Secrets are **namespace-local**: a pod can only reference Secrets in its own namespace. That's why NICo uses External Secrets Operator to copy `nico-roots` and the DB credentials into each NICo namespace, and why an Ingress TLS Secret must live in `nico-rest`. cert-manager also writes the certificates it issues into Secrets.

Here is a habit worth copying from the docs: create Secrets without the value ever touching your shell history, for example
`openssl rand -base64 32 | tr -d '\n' | kubectl -n nico-system create secret generic nico-secrets-kek --from-file=site-kek-1=/dev/stdin`. To read one key, use `-o jsonpath='{.data.ca\.crt}' | base64 -d`.

**Analogy.** A Secret is like a sealed envelope in a locked mailroom. The envelope (base64) only stops people from reading it by accident. The real security is who has a key to the mailroom (RBAC). Where it breaks down: anyone allowed into the mailroom can open every envelope instantly, because there is no extra seal. That's why the `get secrets` permission is so sensitive.

### Worked example: Create, consume and decode a Secret

**Step 1: Create a Secret without leaking it to history.**

```bash
kubectl create namespace sec-demo
openssl rand -base64 24 | tr -d '\n' | \
  kubectl -n sec-demo create secret generic db-creds \
    --from-literal=DB_USER=nico --from-file=DB_PASSWORD=/dev/stdin
kubectl -n sec-demo get secret db-creds -o yaml
```
The values under `data` look scrambled, but they're only base64.

**Step 2: Decode one key.**

```bash
kubectl -n sec-demo get secret db-creds -o jsonpath='{.data.DB_USER}' | base64 -d; echo
# nico
```
Anyone with `get secrets` permission in this namespace can do the same.

**Step 3: Consume it as env vars and as files.**

```bash
cat > sec-pod.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: app
  namespace: sec-demo
spec:
  restartPolicy: Never
  containers:
    - name: c
      image: busybox:1.36
      command: ["sh", "-c", "echo user=$DB_USER; ls /creds"]
      env:
        - name: DB_USER
          valueFrom:
            secretKeyRef:
              name: db-creds
              key: DB_USER
      volumeMounts:
        - name: creds
          mountPath: /creds
          readOnly: true
  volumes:
    - name: creds
      secret:
        secretName: db-creds
EOF
kubectl apply -f sec-pod.yaml
kubectl -n sec-demo wait --for=jsonpath='{.status.phase}'=Succeeded pod/app --timeout=120s
kubectl -n sec-demo logs app
# user=nico
# DB_PASSWORD
# DB_USER
```

**Step 4: See what happens with a missing Secret.**

Copy `sec-pod.yaml` to `sec-pod-bad.yaml`, change `metadata.name` to `app-bad` and `secretKeyRef.name` to `no-such-secret`, then apply it. `kubectl -n sec-demo get pods` shows `CreateContainerConfigError`. This is the classic symptom of a Secret that ESO hasn't synced yet, or that lives in the wrong namespace.

**Step 5: Create an image pull Secret.**

```bash
kubectl -n sec-demo create secret docker-registry imagepullsecret \
  --docker-server=nvcr.io --docker-username='$oauthtoken' --docker-password=dummy-key
kubectl -n sec-demo get secret imagepullsecret -o jsonpath='{.type}'; echo
# kubernetes.io/dockerconfigjson
```
Pods reference it with `imagePullSecrets: [{name: imagepullsecret}]`. The `$oauthtoken` username is NGC's API-key convention, as in the Quick Start.

### Your turn: finish it

Complete this `extraEnv` entry (the same shape as in NICo's Day 0 credential store guide) so `nico-api` gets `NICO_SECRETS_KEK` from the Secret `nico-secrets-kek`, key `site-kek-1`.

```text
extraEnv:
  - name: NICO_SECRETS_KEK
    valueFrom:
      ___:
        name: nico-secrets-kek
        key: ___
```

<details>
<summary>Answer</summary>

`secretKeyRef` and `site-kek-1`:
```yaml
    valueFrom:
      secretKeyRef:
        name: nico-secrets-kek
        key: site-kek-1
```

</details>

### Your turn: on your own

Pods in a new namespace, `nico-rest`, fail with `ImagePullBackOff` against your private registry `my-registry.example.com`, even though `nico-system` pulls fine. Explain the likely cause and give the commands to fix and confirm it.

<details>
<summary>Hint 1</summary>

Secrets are scoped to a namespace.

</details>

<details>
<summary>Hint 2</summary>

Which Secret type carries registry credentials, and where does the pod reference it?

</details>

<details>
<summary>Hint 3</summary>

`kubectl create secret docker-registry ... -n nico-rest`, then add it to `imagePullSecrets` on the pods or patch it onto the namespace's default ServiceAccount.

</details>

<details>
<summary>Answer</summary>

The image pull Secret exists only in `nico-system`, and pods can't use a Secret from another namespace. To fix it, run `kubectl -n nico-rest create secret docker-registry imagepullsecret --docker-server=my-registry.example.com --docker-username=<user> --docker-password=<key>`. Then either reference it through `imagePullSecrets` in the pod spec (usually through chart values), or run `kubectl -n nico-rest patch serviceaccount default -p '{"imagePullSecrets":[{"name":"imagepullsecret"}]}'` and recreate the pods. To confirm, check that `kubectl -n nico-rest describe pod <pod>` shows no more pull errors and `kubectl -n nico-rest get pods` shows Running.

</details>

### Explain it

In your own words: If base64 isn't encryption, what actually keeps a Kubernetes Secret secret? Explain how RBAC, namespaces and tools like ESO work together to limit who can read NICo's database credentials.

### Check

**1. Which statement about Secret `data` values is true?**

A. They are AES-encrypted by kubectl
B. They are base64-encoded, and anyone allowed to get the Secret can decode them
C. They can only be read by the pod that mounts them
D. They are hashed and cannot be recovered

<details>
<summary>Answer</summary>

**B.** They are base64-encoded, and anyone allowed to get the Secret can decode them

Base64 is reversible and adds no security, so access control comes from RBAC. kubectl doesn't encrypt anything, and hashing would make the values useless to applications.

</details>

**2. Why does NICo use ESO to put `nico-roots` and the DB credentials into each NICo namespace?**

A. Secrets expire after 24 hours
B. Pods can only reference Secrets in their own namespace
C. Kubernetes limits each namespace to one Secret
D. ESO encrypts them, which Kubernetes cannot do

<details>
<summary>Answer</summary>

**B.** Pods can only reference Secrets in their own namespace

Secrets are namespace-local, so each namespace needs its own copy. Secrets don't expire, there's no per-namespace limit, and ESO's job is syncing, not encrypting.

</details>

**3. A pod sits in `CreateContainerConfigError` right after deployment. What is a likely Secret-related cause?**

A. The Secret it references doesn't exist yet in that namespace, or is missing the requested key
B. The Secret is too large to mount
C. The image is missing
D. The node has no disk

<details>
<summary>Answer</summary>

**A.** The Secret it references doesn't exist yet in that namespace, or is missing the requested key

If an env var or volume references a missing Secret or key, container creation is blocked with this status. A missing image shows as ImagePullBackOff or ErrImagePull instead.

</details>

**Sources:** [getting-started/installation-options/day0-credential-store.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-credential-store.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md)

<a id="build-task"></a>
## Build task: A mini "site controller" on kind

**Goal:** Build a small stand-in for a NICo control-plane service on a local kind cluster. It is a 2-replica StatefulSet that reads a TOML ConfigMap and DB credentials from a Secret, and keeps its state on PersistentVolumes. You'll expose it as ClusterIP, NodePort and LoadBalancer, register a custom resource type, and give a ServiceAccount least-privilege RBAC that a Job checks from inside the cluster.

**Why it matters for NICo:** Most of NICo's install and day-2 checks come down to the objects you'll build here: StatefulSets with PVCs from local-path StorageClasses (PostgreSQL, Vault, site-agent), Secrets consumed through `secretKeyRef` (db-creds, the KEK), ConfigMaps holding site TOML, LoadBalancer Services waiting for MetalLB VIPs, CRs reconciled by operators, and ServiceAccounts with scoped RBAC. Once you've built and broken these on a laptop, the output of `kubectl get pods,svc,pvc,jobs -n nico-system` on a real site will make sense.

**You need:**

- Docker (or Podman with `KIND_EXPERIMENTAL_PROVIDER=podman`) on Linux or macOS, with about 4 GB of free RAM
- kind (https://kind.sigs.k8s.io)
- kubectl within one minor version of the Kubernetes version your kind node image runs. Recent kind releases use recent Kubernetes versions, so install a current kubectl and compare client and server with `kubectl version` after creating the cluster. NICo's tools table lists kubectl 1.26 as its minimum, but the Kubernetes version-skew rule still applies.
- Internet access to pull `kindest/node`, `python:3.12-slim` and `curlimages/curl`
- openssl (preinstalled on most Linux and macOS systems)
- A working directory, for example `mkdir ~/nico-k8s-lab && cd ~/nico-k8s-lab`

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Create the cluster</summary>

```bash
cat > kind-3.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF
kind create cluster --name nico-lab --config kind-3.yaml
kubectl version          # Server v1.30 or later; Client within one minor version of Server
kubectl get nodes        # 3 nodes Ready
kubectl get storageclass # 'standard' (local-path) should be the default
```

</details>

<details>
<summary>Step 2: Create the namespace, Secret and ConfigMap</summary>

Create the Secret imperatively so the password never appears in a file:
```bash
kubectl create namespace nico-lab
openssl rand -base64 24 | tr -d '\n' | kubectl -n nico-lab create secret generic db-creds \
  --from-literal=DB_USER=nico --from-file=DB_PASSWORD=/dev/stdin
cat > site.toml <<'EOF'
sitename = "mysite"
initial_domain_name = "mysite.example.com"
EOF
kubectl -n nico-lab create configmap site-config --from-file=site.toml
```

</details>

<details>
<summary>Step 3: Deploy the StatefulSet with persistent storage</summary>

```bash
cat > app.yaml <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: fake-api-headless
  namespace: nico-lab
spec:
  clusterIP: None
  selector:
    app: fake-api
  ports:
    - port: 8080
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: fake-api
  namespace: nico-lab
spec:
  serviceName: fake-api-headless
  replicas: 2
  selector:
    matchLabels:
      app: fake-api
  template:
    metadata:
      labels:
        app: fake-api
    spec:
      containers:
        - name: api
          image: python:3.12-slim
          command: ["sh", "-c"]
          args:
            - |
              date >> /data/boots.log
              echo "pod=$(hostname) db_user=$DB_USER" > /data/info.txt
              cp /config/site.toml /data/site.toml
              cd /data && exec python3 -m http.server 8080
          env:
            - name: DB_USER
              valueFrom:
                secretKeyRef:
                  name: db-creds
                  key: DB_USER
          ports:
            - containerPort: 8080
          volumeMounts:
            - name: data
              mountPath: /data
            - name: config
              mountPath: /config
      volumes:
        - name: config
          configMap:
            name: site-config
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: standard
        resources:
          requests:
            storage: 100Mi
EOF
kubectl apply -f app.yaml
kubectl -n nico-lab rollout status statefulset/fake-api --timeout=180s
kubectl -n nico-lab get pods,pvc
```
You should see pods `fake-api-0` and `fake-api-1`, and PVCs `data-fake-api-0` and `data-fake-api-1`, all `Bound`.

</details>

<details>
<summary>Step 4: Expose it three ways</summary>

```bash
cat > svcs.yaml <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: fake-api
  namespace: nico-lab
spec:
  type: ClusterIP
  selector:
    app: fake-api
  ports:
    - port: 80
      targetPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: fake-api-np
  namespace: nico-lab
spec:
  type: NodePort
  selector:
    app: fake-api
  ports:
    - port: 80
      targetPort: 8080
      nodePort: 30080
---
apiVersion: v1
kind: Service
metadata:
  name: fake-api-lb
  namespace: nico-lab
spec:
  type: LoadBalancer
  selector:
    app: fake-api
  ports:
    - port: 80
      targetPort: 8080
EOF
kubectl apply -f svcs.yaml
kubectl -n nico-lab get svc
```
`fake-api-lb` stays at EXTERNAL-IP `<pending>` because kind has no MetalLB. It is the same symptom the Quick Start warns about for NICo Core.

</details>

<details>
<summary>Step 5: Register a custom resource type</summary>

```bash
cat > crd.yaml <<'EOF'
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: racks.lab.example.com
spec:
  group: lab.example.com
  scope: Namespaced
  names:
    plural: racks
    singular: rack
    kind: Rack
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                location:
                  type: string
                hosts:
                  type: integer
EOF
kubectl apply -f crd.yaml
kubectl wait --for=condition=Established crd/racks.lab.example.com --timeout=60s
cat > rack.yaml <<'EOF'
apiVersion: lab.example.com/v1
kind: Rack
metadata:
  name: rack-a01
  namespace: nico-lab
spec:
  location: row-a
  hosts: 18
EOF
kubectl apply -f rack.yaml
kubectl -n nico-lab get racks
```

</details>

<details>
<summary>Step 6: Add least-privilege RBAC and check it from inside a pod</summary>

The Job calls the Kubernetes API directly with its ServiceAccount token:
```bash
cat > rbac.yaml <<'EOF'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: config-reader
  namespace: nico-lab
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: configmap-reader
  namespace: nico-lab
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: config-reader-binding
  namespace: nico-lab
subjects:
  - kind: ServiceAccount
    name: config-reader
    namespace: nico-lab
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: configmap-reader
---
apiVersion: batch/v1
kind: Job
metadata:
  name: rbac-probe
  namespace: nico-lab
spec:
  backoffLimit: 0
  template:
    spec:
      serviceAccountName: config-reader
      restartPolicy: Never
      containers:
        - name: probe
          image: curlimages/curl
          command: ["sh", "-c"]
          args:
            - |
              SA=/var/run/secrets/kubernetes.io/serviceaccount
              TOKEN=$(cat $SA/token)
              API=https://kubernetes.default.svc/api/v1/namespaces/nico-lab
              echo "configmaps: $(curl -s -o /dev/null -w '%{http_code}' --cacert $SA/ca.crt -H "Authorization: Bearer $TOKEN" $API/configmaps)"
              echo "secrets: $(curl -s -o /dev/null -w '%{http_code}' --cacert $SA/ca.crt -H "Authorization: Bearer $TOKEN" $API/secrets)"
EOF
kubectl apply -f rbac.yaml
kubectl -n nico-lab wait --for=condition=complete job/rbac-probe --timeout=120s
kubectl -n nico-lab logs job/rbac-probe
```
Expected output: `configmaps: 200` and `secrets: 403`.

</details>

<details>
<summary>Step 7: Prove persistence and reachability</summary>

```bash
# Delete a replica. It comes back with the same name and the same volume.
kubectl -n nico-lab delete pod fake-api-0
sleep 5   # give the StatefulSet controller a moment to recreate the pod
kubectl -n nico-lab rollout status statefulset/fake-api --timeout=180s
kubectl -n nico-lab exec fake-api-0 -- wc -l /data/boots.log
# 2 /data/boots.log  (one line per start)

# Per-pod DNS through the headless Service: always reaches fake-api-0
kubectl run tmp -n nico-lab --rm -i --quiet --restart=Never --image=curlimages/curl -- \
  -s http://fake-api-0.fake-api-headless.nico-lab.svc.cluster.local:8080/info.txt

# Through the ClusterIP Service: port 80, load-balanced across both replicas
kubectl run tmp1 -n nico-lab --rm -i --quiet --restart=Never --image=curlimages/curl -- \
  -s http://fake-api.nico-lab.svc.cluster.local/site.toml

# Through the NodePort on a node IP
NODE=$(kubectl get nodes -o jsonpath='{.items[1].status.addresses[?(@.type=="InternalIP")].address}')
kubectl run tmp2 -n nico-lab --rm -i --quiet --restart=Never --image=curlimages/curl -- \
  -s http://$NODE:30080/site.toml
```
`boots.log` should have **two** lines. The headless request names `fake-api-0`, and both the ClusterIP and NodePort requests return your TOML. Run the ClusterIP request with `/info.txt` a few times and you'll see answers from both pods.

</details>

**Check it works:** Run these and compare each result with the expected value:
```bash
kubectl -n nico-lab get statefulset fake-api          # READY 2/2
kubectl -n nico-lab get pvc                            # data-fake-api-0 and -1 Bound
kubectl -n nico-lab get svc                            # fake-api ClusterIP, fake-api-np 80:30080, fake-api-lb <pending>
kubectl -n nico-lab get racks                          # rack-a01
kubectl -n nico-lab logs job/rbac-probe                # configmaps: 200 / secrets: 403
kubectl auth can-i list secrets -n nico-lab --as=system:serviceaccount:nico-lab:config-reader   # no
kubectl -n nico-lab exec fake-api-0 -- wc -l /data/boots.log                                    # 2 (or more) /data/boots.log
kubectl run v -n nico-lab --rm -i --quiet --restart=Never --image=curlimages/curl -- \
  -s http://fake-api.nico-lab.svc.cluster.local/site.toml                                       # prints your site.toml
```
The task is done when every line matches: 2/2 ready, both PVCs Bound, the LB pending, the CR listed, 200/403 from the probe, `no` from can-i, at least 2 lines in `boots.log` (proving the volume survived the pod restart), and the TOML served through the ClusterIP Service.

<details>
<summary>If you get stuck</summary>

- Pods stuck in `CreateContainerConfigError`: the `db-creds` Secret is missing or was created in a different namespace. Check with `kubectl -n nico-lab get secret db-creds`.
- PVCs stuck in `Pending` before any pods exist is normal for `WaitForFirstConsumer`. If they stay Pending after pods are scheduled, check `kubectl get pods -n local-path-storage` and `kubectl describe pvc`.
- `kubectl apply -f rack.yaml` says `no matches for kind "Rack"`: the CRD wasn't established yet. Run the `kubectl wait --for=condition=Established` line and apply again.
- The rbac-probe Job shows `configmaps: 403`: check that the RoleBinding's subject name and namespace exactly match the ServiceAccount, and that the Job sets `serviceAccountName: config-reader`. Jobs are immutable, so delete it (`kubectl -n nico-lab delete job rbac-probe`) and apply again.
- `kubectl -n nico-lab exec fake-api-0` says the pod is not found or not running: the StatefulSet hasn't finished recreating it. Re-run `kubectl -n nico-lab rollout status statefulset/fake-api`.
- `kubectl run tmp` fails with `AlreadyExists`: an earlier run left the pod behind. Run `kubectl -n nico-lab delete pod tmp`.
- kubectl warns about version skew, or commands behave oddly: install a kubectl within one minor version of the server shown by `kubectl version`.
- On Podman, run `export KIND_EXPERIMENTAL_PROVIDER=podman` before `kind create cluster`.

</details>

**Stretch goal:** Give `fake-api-lb` a real, *pinned* VIP. Install MetalLB in kind with `kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.14.5/config/manifests/metallb-native.yaml` (v0.14.5 is the version NICo validates). Find kind's Docker subnet with `docker network inspect kind`, then in `metallb-system` create an `IPAddressPool` with a small range from the top of that subnet and an `L2Advertisement`. Annotate the Service with `metallb.universe.tf/loadBalancerIPs: <an IP from the pool>` and watch EXTERNAL-IP change from `<pending>` to exactly that address. Delete and recreate the Service and confirm the IP stays the same, which is the reason the first lesson gave for pinning VIPs. On Linux you can `curl http://<VIP>/info.txt` from the host. On macOS the kind network isn't routable from the host, so test from a pod instead. Bonus: create two LoadBalancer Services, each selecting one replica through the `statefulset.kubernetes.io/pod-name` label, so each replica gets its own VIP. This mimics `perPodAnnotations` for nico-dns and nico-ntp.

## Review notes

The draft was rewritten once using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **ok**, no issues found.

---

[← 13-building-images.md](13-building-images.md) · [15-cluster-networking.md →](15-cluster-networking.md)
