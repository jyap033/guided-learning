# Chapter 15: Cluster Networking

*Part: Kubernetes & Deployment · 5 concepts · [curriculum](../curriculum.md#chapter-15)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Chapter 14 gave you Kubernetes objects: Pods, Deployments, Services and the three Service types. One question was left open. When a NICo Service says `type: LoadBalancer`, where does its IP come from, and how does a BMC three racks away send packets to it? On a cloud provider, a managed load balancer handles that. On bare metal, nothing does it for you. This chapter covers the pieces that fill that gap.

There are three layers. The **CNI** gives every pod an IP and makes pods reachable across nodes. NICo validates **Calico**, which uses BGP inside the cluster, so you'll reuse what you learned in Chapter 9. **MetalLB** gives LoadBalancer Services stable virtual IPs (VIPs) and advertises them outside the cluster. It does this either over BGP to the top-of-rack switches (the NICo reference design) or by answering **Layer 2 ARP** requests on a flat network (labs and dev). The chapter opens with **Tilt**, the inner-loop dev tool whose image recipes NICo shares with `make images-dev`. That way you know where Tilt fits before you build clusters by hand.

Why NICo cares: the DHCP relay on the OOB switches, the PXE URLs that hosts boot from and the API hostname in DNS all point at fixed VIPs. If those VIPs are missing, unstable or unreachable, no host can be discovered. NICo also tells tenants that their clusters run over routed /31 links, not shared L2. That limits which CNI and VIP modes they can use.

At the end you'll build a laptop cluster with kind, Calico and MetalLB in L2 mode. You'll prove from outside the cluster that a pinned VIP answers, and you'll identify which node answers ARP for it.

**By the end of this chapter you can:**

- Explain what Tilt automates in a Kubernetes inner loop and how it relates to NICo's `make images-dev` target
- Describe what a CNI plugin does, and choose a CNI setup that works over routed (non-L2) node connectivity such as NICo FNN tenant networks
- Write MetalLB IPAddressPool, BGPPeer, BGPAdvertisement and L2Advertisement objects, pin a Service to a specific VIP, and tell an allocation failure (`<pending>`) apart from an advertisement failure
- Inspect Calico's BIRD BGP sessions, and raise calico-node probe timeouts when BIRD health checks are slow but BGP is healthy
- Use ARP observations to find which node answers for a MetalLB Layer 2 VIP, and explain why L2 mode suits labs but not routed fabrics

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [Tilt](#tilt)
2. [CNI](#cni)
3. [MetalLB LoadBalancer VIPs](#metallb-loadbalancer-vips)
4. [Calico networking](#calico-networking)
5. [Layer 2 advertisement (ARP)](#layer-2-advertisement)
6. [Build task: A laptop site-controller network: kind + Calico + MetalLB L2 with a pinned VIP](#build-task)

<a id="tilt"></a>
## 1. Tilt

*Builds on: Kubernetes (ch. 14)*

### Before you read

- You change one line of Go or Rust in a service that runs in a local Kubernetes cluster. List the manual steps needed before your change is actually running in the pod.
- Guess: does Tilt replace the Dockerfile and Kubernetes YAML, or does it use them?

<details>
<summary>Answers</summary>

- **You change one line of Go or Rust in a service that runs in a local Kubernetes cluster. List the manual steps needed before your change is actually running in the pod.** Rebuild the container image. Make the image available to the cluster (push it to a registry or load it into kind). Update or restart the Deployment so pods use the new image. Wait for the rollout, then re-attach logs and port-forwards. Tilt automates this loop.
- **Guess: does Tilt replace the Dockerfile and Kubernetes YAML, or does it use them?** It uses them. Tilt reads a Tiltfile that points at your existing Dockerfiles and manifests, then runs the build, load and deploy steps for you.

</details>

### Explanation

**Tilt** is a local development tool for Kubernetes. You describe your services in a file called a `Tiltfile`, written in Starlark, a small Python-like language. Then you run `tilt up`. Tilt watches your source files. When one changes, it:

1. rebuilds the affected container image,
2. makes the image available to your dev cluster (for example kind),
3. re-applies the Kubernetes YAML so pods pick up the new image,
4. streams logs and keeps port-forwards open in a web UI (by default at `http://localhost:10350`).

The three Tiltfile functions you'll see most often:

- `docker_build('image-name', 'context-dir')`: how to build an image.
- `k8s_yaml('file.yaml')`: which manifests to deploy. Tilt matches image names in the YAML to the images it builds.
- `k8s_resource('workload-name', port_forwards='8080:8000')`: per-workload options. In `'LOCAL:CONTAINER'` form, this forwards local port 8080 to container port 8000. A bare number such as `8080` uses the same port on both sides.

Tilt can also do a **live update**. Instead of rebuilding the image, it copies changed files straight into the running container with `sync(...)`. This is useful for interpreted code and static files.

**How NICo uses this.** The NICo repo has a Tilt-based dev deployment, documented in `dev/deployment/tilt/README.md`. The build manual says `make images-dev` builds one native Core development image "using the same recipes as Tilt". The shared recipes are `dev/docker/Dockerfile.dev-services` and `dev/docker/Dockerfile.dev-runtime`. For example, `make images-dev DEV_TARGET=dhcp` produces `nico-dev-dhcp:latest`.

The manual is explicit about where `make images-dev` stops: it does **not** push images, create a registry, load images into kind or deploy services. Those steps belong to the inner loop that Tilt handles. Because the recipes are shared, an image you build by hand and an image Tilt builds come from the same Dockerfiles.

Tilt is only a development tool. Production NICo sites deploy with `setup.sh`, Helm and optionally ArgoCD.

**Analogy.** Tilt is like a build-on-save setting in an IDE, but for a whole cluster: you save a file and the running app updates. The analogy breaks down because Tilt is doing real distributed work: it builds images, loads them into a cluster and rolls pods. A slow image build or a crashing pod shows up as a red resource in Tilt's UI, not as a quick compile error.

### Worked example: Run a tiny Python service under Tilt on kind

**Step 1: Create a dev cluster.**

```bash
kind create cluster --name tiltlab
kubectl cluster-info --context kind-tiltlab
```

**Step 2: Write the app and Dockerfile.**

```bash
mkdir hello && cd hello
cat > app.py <<'EOF'
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers()
        self.wfile.write(b"hello v1\n")
HTTPServer(("", 8000), H).serve_forever()
EOF
cat > Dockerfile <<'EOF'
FROM python:3.12-slim
WORKDIR /app
COPY app.py .
CMD ["python", "-u", "app.py"]
EOF
```
The app listens on port **8000** inside the container.

**Step 3: Write the Kubernetes manifest.**

```bash
cat > k8s.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-api
spec:
  replicas: 1
  selector:
    matchLabels: {app: hello-api}
  template:
    metadata:
      labels: {app: hello-api}
    spec:
      containers:
        - name: hello-api
          image: hello-api
          ports:
            - containerPort: 8000
EOF
```
Tilt matches the `image: hello-api` name against its `docker_build`.

**Step 4: Write the Tiltfile and start Tilt.**

```bash
cat > Tiltfile <<'EOF'
docker_build('hello-api', '.')
k8s_yaml('k8s.yaml')
k8s_resource('hello-api', port_forwards='8080:8000')
EOF
tilt up
```
Press space to open the UI. When `hello-api` turns green, run `curl localhost:8080` in another terminal. You should get `hello v1`, because local 8080 is forwarded to container port 8000.

**Step 5: Change code and watch the loop.**

Edit `app.py` to return `hello v2` and save. In the Tilt UI you'll see a rebuild, an image load into kind and a pod rollout. `curl localhost:8080` now prints `hello v2`, and you didn't run `docker build` or `kubectl` yourself. Stop with Ctrl-C, run `tilt down` to delete the deployed resources, then run `kind delete cluster --name tiltlab`.

### Your turn: finish it

Fill in the blanks so this Tiltfile builds the `hello-api` image from the current directory, deploys `k8s.yaml`, and forwards local port 8080 to port 8000, where the app listens inside the container.

```text
___('hello-api', '.')
k8s_yaml('k8s.yaml')
k8s_resource('hello-api', ___='8080:8000')
```

<details>
<summary>Answer</summary>

First blank: `docker_build`. Second blank: `port_forwards`. Full file:
```
docker_build('hello-api', '.')
k8s_yaml('k8s.yaml')
k8s_resource('hello-api', port_forwards='8080:8000')
```

</details>

### Your turn: on your own

Your service also serves files from `./static/`, which ends up at `/app/static/` in the image. Rebuilding the image for every CSS tweak is slow. Change the `docker_build` line so that edits under `./static/` are copied into the running container without an image rebuild.

<details>
<summary>Hint 1</summary>

Tilt calls this feature live update. It is an argument to `docker_build`.

</details>

<details>
<summary>Hint 2</summary>

The argument takes a list of steps. The step that copies files is `sync(local_path, container_path)`.

</details>

<details>
<summary>Hint 3</summary>

`docker_build('hello-api', '.', live_update=[sync(..., ...)])`

</details>

<details>
<summary>Answer</summary>

```
docker_build('hello-api', '.', live_update=[
    sync('./static/', '/app/static/'),
])
```
Your Dockerfile must also copy `static/` into `/app/static/` (for example `COPY static/ static/`). That way a full rebuild gives the same result as a live update.

</details>

### Explain it

In your own words: NICo's `make images-dev` uses the same Dockerfile recipes as Tilt but stops before loading or deploying anything. Why is it useful to share the recipes, and why might the NICo developers have kept the deploy step out of `make images-dev`?

### Check

**1. Which of these does `make images-dev DEV_TARGET=dhcp` do, according to the NICo build manual?**

A. Builds `nico-dev-dhcp:latest` in the selected Docker daemon
B. Builds the image and loads it into the kind cluster
C. Builds and pushes the image to `localhost:5000`
D. Builds the image and runs `tilt up` for the DHCP service

<details>
<summary>Answer</summary>

**A.** Builds `nico-dev-dhcp:latest` in the selected Docker daemon

The manual says it builds a compiler image, a common runtime image and `nico-dev-dhcp:latest`. It also says the target does not push images, create a registry, load images into kind or deploy services. Pushing to `localhost:5000` is what `make images` does, not `images-dev`.

</details>

**2. In a Tiltfile, how does Tilt know that the image built by `docker_build('hello-api', '.')` belongs in your Deployment?**

A. It matches the image name `hello-api` to `image:` fields in the YAML loaded by `k8s_yaml`
B. It uses the Deployment's name, which must match the directory name
C. You must push the image to Docker Hub and reference the full URL
D. It injects the image into every pod in the namespace

<details>
<summary>Answer</summary>

**A.** It matches the image name `hello-api` to `image:` fields in the YAML loaded by `k8s_yaml`

Tilt rewrites matching `image:` references to the tag it just built. Directory names don't matter, kind doesn't need a public registry, and Tilt only replaces images whose names match.

</details>

**3. Is Tilt part of a production NICo site deployment?**

<details>
<summary>Answer</summary>

No. Tilt is a local development tool. Production sites are deployed with `setup.sh` (Helm/helmfile), optionally with ArgoCD.

The docs mention Tilt only when describing dev image builds. The Quick Start deploys with `setup.sh`.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="cni"></a>
## 2. CNI

*Builds on: Kubernetes (ch. 14), IP networking fundamentals (ch. 3)*

### Before you read

- Kubernetes gives every pod its own IP address. Which component do you think creates the pod's network interface and assigns that IP: the kubelet, the container runtime, or a plugin?
- Pod A is on node 1 and pod B is on node 2. The nodes are on different /31 subnets joined by a router. Can node 1 reach node 2 by ARP?

<details>
<summary>Answers</summary>

- **Kubernetes gives every pod its own IP address. Which component do you think creates the pod's network interface and assigns that IP: the kubelet, the container runtime, or a plugin?** A CNI plugin. When the container runtime (for example containerd) creates the pod's network namespace, it calls the CNI plugin configured on the node. The plugin creates the interface and assigns the IP.
- **Pod A is on node 1 and pod B is on node 2. The nodes are on different /31 subnets joined by a router. Can node 1 reach node 2 by ARP?** No. ARP only works inside one L2 segment. Node 1 must send packets to its gateway (the router), so pod traffic has to be routed or tunnelled.

</details>

### Explanation

Kubernetes requires a flat pod network: every pod gets an IP, and any pod can reach any other pod without NAT, even across nodes. Kubernetes doesn't implement this itself. It hands the job to a **CNI** (Container Network Interface) plugin.

CNI is a specification. When containerd creates a pod sandbox, it reads the config in `/etc/cni/net.d/` and runs the plugin binary named there (usually from `/opt/cni/bin/`). The plugin then:

1. creates a virtual interface (often a veth pair) between the pod's network namespace and the host,
2. assigns the pod an IP from that node's pod CIDR (this is called IPAM, IP address management),
3. makes sure other nodes can reach that IP.

CNIs differ in how they handle step 3. Some common strategies:

- **Direct L2 routes**: each node adds a route "pod CIDR of node X via node X's IP". This only works if every node is on the same L2 segment. Flannel `host-gw` is an example.
- **Routing protocol**: nodes announce their pod CIDRs with BGP. Calico does this with its BIRD daemon.
- **Overlay**: pod packets are wrapped in VXLAN or IP-in-IP between node IPs. The underlying network only needs to route node-to-node traffic.

Until a CNI is installed, nodes stay `NotReady`.

**NICo and CNI: two different roles.**

1. *The site controller cluster.* NICo's own Kubernetes cluster needs a CNI. The validated one is **Calico v3.28.1**. The install order puts "Calico (or conformant CNI)" in step 1, before everything else.
2. *Tenant clusters.* Tenants build their own clusters on NICo instances. Cluster networking (CNI, service mesh) is the platform's responsibility, not NICo's. In FNN VPCs, each instance interface gets a `/31` point-to-point link to its DPU gateway, and interfaces in the same VPC are **not** L2-adjacent. So the docs tell you to choose a CNI configuration that "supports routed nodes or builds its own overlay". It must not depend on broadcast discovery, ARP between nodes or an L2-advertised service VIP.

**Analogy.** A CNI is like the mailroom in a building. Kubernetes promises every desk (pod) a unique address, and the mailroom works out how letters reach desks on other floors (nodes). The analogy breaks down because a mailroom can always walk the stairs. A CNI that assumes all nodes share one floor (L2) simply fails when the floors are joined only by routers.

### Worked example: Look at how kind's default CNI (kindnet) connects pods across nodes

**Step 1: Create a multi-node cluster.**

```bash
cat > kind-3.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF
kind create cluster --name cnilab --config kind-3.yaml
```

**Step 2: Find the CNI config on a node.**

```bash
docker exec cnilab-control-plane ls /etc/cni/net.d
docker exec cnilab-control-plane cat /etc/cni/net.d/10-kindnet.conflist
```
The config names the plugins containerd runs for every pod (`ptp`, `portmap` and so on) and the IPAM range.

**Step 3: See pod IPs per node.**

```bash
kubectl create deployment web --image=nginx --replicas=4
kubectl get pods -o wide
```
Pods on different nodes get IPs from different per-node ranges (for example `10.244.1.x` and `10.244.2.x`).

**Step 4: See how the node reaches other nodes' pods.**

```bash
docker exec cnilab-worker ip route
```
You'll see lines like `10.244.2.0/24 via 172.18.0.3 dev eth0`. This is a plain IP route to the other node's pod CIDR. It works here only because all kind nodes share one Docker bridge, which is a single L2 segment.

**Step 5: Clean up.**

```bash
kind delete cluster --name cnilab
```

### Your turn: finish it

Fill in the blanks to (1) list the CNI configuration files on the kind control-plane node and (2) show which node each pod runs on, along with its IP.

```text
docker exec cnilab-control-plane ls ___
kubectl get pods -o ___
```

<details>
<summary>Answer</summary>

`/etc/cni/net.d` and `wide`:
```bash
docker exec cnilab-control-plane ls /etc/cni/net.d
kubectl get pods -o wide
```

</details>

### Your turn: on your own

A tenant is building Kubernetes on three NICo FNN instances. Each node's interface is a /31 to its DPU gateway, and all three are in the same VPC. They plan to use a CNI mode that installs `pod CIDR via <other node IP>` routes and expects nodes to reach each other directly on one subnet. They also plan to use MetalLB in L2 mode for their ingress VIP. Explain what breaks and what they should choose instead.

<details>
<summary>Hint 1</summary>

Look at the next hop in a route like `10.244.2.0/24 via 10.0.0.5`. To use it, the node must ARP for 10.0.0.5. Is 10.0.0.5 on its /31?

</details>

<details>
<summary>Hint 2</summary>

The NICo docs say that allocating interfaces from the same VPC prefix does not make them L2-adjacent.

</details>

<details>
<summary>Hint 3</summary>

Pick something that only needs node-to-node IP reachability: an overlay (VXLAN/IP-in-IP), or route announcements that the network actually carries. Then announce the VIP by routing, not ARP.

</details>

<details>
<summary>Answer</summary>

Direct-route mode fails. The other node's IP isn't on the local /31, so the kernel can't use it as an on-link next hop, and an ARP for it never reaches the other node. Pod traffic across nodes breaks. MetalLB L2 mode fails for the same reason: nobody outside the /31 hears its ARP replies, so the rest of the VPC can't reach the VIP. Instead, use a CNI configuration that builds its own overlay (for example Calico or Flannel with VXLAN encapsulation), so the fabric only has to route node IPs. Expose service VIPs with a routed mechanism such as BGP announcements (see NICo's BGP peering guidance), not L2 advertisement.

</details>

### Explain it

In your own words: In your own words: why does it matter to a CNI whether nodes share an L2 segment? Which of the three cross-node strategies (direct routes, BGP, overlay) needs the least from the underlying network?

### Check

**1. On a node with no CNI installed, what state do you expect the node and new pods to be in?**

A. Node NotReady; pods stay Pending/ContainerCreating
B. Node Ready; pods run but only reach pods on the same node
C. Node Ready; Kubernetes falls back to its built-in pod network
D. Node NotReady; pods run with host networking

<details>
<summary>Answer</summary>

**A.** Node NotReady; pods stay Pending/ContainerCreating

Kubernetes has no built-in pod network. The kubelet reports the node network as not ready until a CNI config exists, so normal pods can't get a network sandbox. Only pods that use host networking can run.

</details>

**2. According to NICo's scope page, who is responsible for the CNI inside a tenant's Kubernetes cluster built on NICo instances?**

A. The tenant's platform / ISV control plane
B. NICo Core, which installs Calico on each instance
C. The DPU Agent, through HBN
D. The network team, via ToR configuration

<details>
<summary>Answer</summary>

**A.** The tenant's platform / ISV control plane

The scope table lists "Cluster networking (CNI, service mesh)" under "Your platform handles". NICo provides per-tenant network isolation at the DPU. It does not provide the cluster's pod network.

</details>

**3. Which CNI is validated for the NICo site controller cluster, and at what version?**

<details>
<summary>Answer</summary>

Calico v3.28.1 (node and controllers).

This is listed in the Software Prerequisites and in the Quick Start validated baseline. Other conformant CNIs are allowed, but Calico is the one that was tested.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [overview/scope-and-boundaries.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/scope-and-boundaries.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="metallb-loadbalancer-vips"></a>
## 3. MetalLB LoadBalancer VIPs

*Builds on: BGP (ch. 9), Kubernetes Service types (LoadBalancer, NodePort, ClusterIP) (ch. 14)*

### Before you read

- On a bare-metal Kubernetes cluster with no cloud provider, you create a Service of `type: LoadBalancer`. What do you expect `kubectl get svc` to show in the EXTERNAL-IP column?
- The OOB switches relay BMC DHCP requests to a configured server IP. Why would it be bad if the nico-dhcp Service got a different IP each time NICo is reinstalled?

<details>
<summary>Answers</summary>

- **On a bare-metal Kubernetes cluster with no cloud provider, you create a Service of `type: LoadBalancer`. What do you expect `kubectl get svc` to show in the EXTERNAL-IP column?** `<pending>`, indefinitely. Nothing in vanilla Kubernetes allocates or advertises external IPs. A cloud controller, or something like MetalLB, must do it.
- **The OOB switches relay BMC DHCP requests to a configured server IP. Why would it be bad if the nico-dhcp Service got a different IP each time NICo is reinstalled?** The relay configuration (and the DNS records, PXE config and API hostname) would point at a stale IP. BMCs could no longer reach DHCP, so hosts couldn't be discovered.

</details>

### Explanation

In Chapter 14 you learned that a `LoadBalancer` Service expects something outside Kubernetes to give it an external IP. Public clouds have a controller that does this. Bare metal doesn't, so Services stay `<pending>`. **MetalLB** fills the gap. It has two parts:

- the **controller** (a Deployment), which **allocates** an IP from a pool and writes it into the Service's status,
- the **speaker** (a DaemonSet on the host network), which **advertises** that IP, telling the outside network where it lives.

You configure MetalLB with custom resources in the `metallb-system` namespace:

| CR | Purpose |
|---|---|
| `IPAddressPool` | Ranges MetalLB may hand out (the VIPs) |
| `BGPPeer` | A router to open a BGP session with: `myASN`, `peerASN`, `peerAddress`, optional `nodeSelectors` |
| `BGPAdvertisement` | Announce pool addresses as routes over those BGP sessions |
| `L2Advertisement` | Announce pool addresses by answering ARP (next lesson) |

In BGP mode, each speaker announces a `/32` route for the VIP to its ToR, with its own node as next hop. Routers then forward VIP traffic to the nodes, and kube-proxy delivers it to a pod.

**Allocation and advertisement fail in different ways.**

- EXTERNAL-IP shows `<pending>`: the **controller** didn't allocate. Typical causes are no matching `IPAddressPool`, an exhausted pool, or a pinned IP that is outside every pool or already used by another Service. Check the pools and `kubectl -n metallb-system logs deploy/controller`.
- EXTERNAL-IP is set but unreachable from outside: the **speakers** aren't advertising it properly. Check the BGP sessions on the ToRs, the `peerAddress`/ASNs in `BGPPeer`, and that a `BGPAdvertisement` covers the pool.

The Quick Start lists both sets of checks together under its `<pending>` troubleshooting. When you debug, look at allocation first.

**Why NICo depends on MetalLB.** NICo's pods (DHCP, DNS, API, PXE, SSH console and others) must be routable to and from host and DPU BMCs, the admin network and tenant VPCs. The reference architecture is "MetalLB advertising L3 LoadBalancer VIPs to the site controller's DPU uplinks (if DPUs are present) or directly to the ToR switches". The validated version is v0.14.5. The network plan reserves a control plane service IP pool, typically a `/27`.

In `helm-prereqs/values/metallb-config.yaml` you set an internal and an external `IPAddressPool`, one `myASN` for the cluster, and one `BGPPeer` per node. Each `BGPPeer` has that node's ToR `peerASN`, `peerAddress` and hostname selector. Then, in `nico-core.yaml`, you pin **specific** VIPs per service with annotations (`nico-api`, `nico-dhcp`, `nico-pxe`, `nico-ssh-console-rs`, and `perPodAnnotations` for each `nico-dns` replica). If you don't pin them, MetalLB picks IPs at random on each install, and the DHCP relay, DNS and PXE config break. If MetalLB is missing, these Services stay `<pending>` and the site is unreachable.

**Analogy.** MetalLB is like a receptionist who assigns extension numbers (VIPs) and then tells the building's phone switch (ToR) which desk each extension rings. If no extension number has been assigned, that's the receptionist's problem (allocation). If a number is assigned but never rings, the phone switch was never told (advertisement). The analogy breaks down because with BGP several nodes can announce the same VIP at once, and the router spreads calls across them (ECMP). An office extension rings only one desk.

### Worked example: Read a NICo-style MetalLB config and check VIPs after install

**Step 1: Identify the pools.**

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: example-internal
  namespace: metallb-system
spec:
  addresses:
    - 10.180.126.160/28
```
A `/28` holds 16 addresses (`.160`-`.175`). Every pinned service VIP must fall inside a pool and be unique across services.

**Step 2: Identify the BGP peers.**

```yaml
apiVersion: metallb.io/v1beta2
kind: BGPPeer
metadata:
  name: node1-tor
  namespace: metallb-system
spec:
  myASN: 4244766850
  peerASN: 4244766851
  peerAddress: 10.180.248.80
  nodeSelectors:
    - matchLabels:
        kubernetes.io/hostname: node1
```
`myASN` is the same for all nodes. `peerASN` and `peerAddress` belong to each node's own ToR. The node selector limits this session to `node1`'s speaker. Add one block per node.

**Step 3: Tie pool to BGP.**

```yaml
apiVersion: metallb.io/v1beta1
kind: BGPAdvertisement
metadata:
  name: example-bgp
  namespace: metallb-system
spec:
  ipAddressPools:
    - example-internal
```

**Step 4: Pin a VIP on a Service (generic MetalLB).**

In plain MetalLB v0.14, a Service asks for a specific IP with an annotation:
```yaml
metadata:
  annotations:
    metallb.universe.tf/loadBalancerIPs: 10.180.126.161
```
In NICo you put the annotation under the chart value, for example `nico-dhcp.externalService.annotations`, instead of editing Services by hand.

**Step 5: Verify allocation, then advertisement.**

```bash
kubectl get ipaddresspool,bgppeer -n metallb-system
kubectl get svc -n nico-system | grep LoadBalancer
```
**Allocation:** every LoadBalancer row needs an EXTERNAL-IP from your pools. If a row shows `<pending>`, the controller couldn't allocate. Check that the pinned IP is inside a pool and not already used, that the pool isn't exhausted, and read `kubectl -n metallb-system logs deploy/controller`.

**Advertisement:** if the IP is assigned but nothing outside the cluster can reach it, check the BGP sessions on the ToRs and the peer addresses and ASNs in `metallb-config.yaml`. The Quick Start mentions both groups of checks together; it helps to know which group applies.

### Your turn: finish it

Complete this MetalLB config. The internal VIP pool is `10.180.126.160/28`, and node1's ToR uses ASN `4244766851`.

```text
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: example-internal
  namespace: metallb-system
spec:
  addresses:
    - ___
---
apiVersion: metallb.io/v1beta2
kind: BGPPeer
metadata:
  name: node1-tor
  namespace: metallb-system
spec:
  myASN: 4244766850
  peerASN: ___
  peerAddress: 10.180.248.80
  nodeSelectors:
    - matchLabels:
        kubernetes.io/hostname: node1
---
apiVersion: metallb.io/v1beta1
kind: BGPAdvertisement
metadata:
  name: example-bgp
  namespace: metallb-system
spec:
  ipAddressPools:
    - example-internal
```

<details>
<summary>Answer</summary>

First blank: `10.180.126.160/28`. Second blank: `4244766851`. The lines read `    - 10.180.126.160/28` and `  peerASN: 4244766851`.

</details>

### Your turn: on your own

Plan VIP assignments for a NICo site. You must pin VIPs for the nico-api external API, nico-dhcp, two nico-dns replicas, nico-pxe and nico-ssh-console-rs. You also want the built-in nico-ntp service, which needs one VIP per replica (3 replicas). Your internal pool is `10.20.0.0/28` and your external pool is `10.20.0.16/28`. Assign addresses. For api, dhcp and dns, say which config key each assignment goes into, and in which file.

<details>
<summary>Hint 1</summary>

Count first: 1 + 1 + 2 + 1 + 1 = 6 core VIPs, plus 3 for NTP = 9. Do the pools have room?

</details>

<details>
<summary>Hint 2</summary>

The Quick Start table says which pool each service uses: api uses external, while dhcp, pxe and ssh-console use internal. DNS may use either. NTP VIPs come from the internal pool.

</details>

<details>
<summary>Hint 3</summary>

The keys live in `helm-prereqs/values/nico-core.yaml`: `<service>.externalService.annotations`, except DNS and NTP, which use `perPodAnnotations` (a list with one entry per replica).

</details>

<details>
<summary>Answer</summary>

One valid plan. External: nico-api = 10.20.0.17. Internal: nico-dhcp = 10.20.0.1, nico-pxe = 10.20.0.2, nico-ssh-console-rs = 10.20.0.3, nico-dns[0] = 10.20.0.4, nico-dns[1] = 10.20.0.5, nico-ntp = 10.20.0.6, .7 and .8. All of them are inside the pools defined in `values/metallb-config.yaml`, and all are unique. The keys in `values/nico-core.yaml` are `nico-api.externalService.annotations`, `nico-dhcp.externalService.annotations` (also set `externalService.enabled: true`, because it defaults to false), and `nico-dns.externalService.perPodAnnotations[0]` and `[1]`. For NTP, set `nico-ntp.externalService.enabled: true`, list the three VIPs in `perPodAnnotations`, and put the same VIPs, comma-separated, in `nico-dhcp.config.kea.hookParameters.ntpServer`. The nico-api VIP must resolve in DNS to the configured API hostname. If any pinned address falls outside a pool, that Service stays `<pending>`.

</details>

### Explain it

In your own words: Why does NICo insist on explicitly pinned VIPs instead of letting MetalLB choose? Answer in terms of the systems outside the cluster that hold those IPs in their own configuration.

### Check

**1. After `setup.sh`, `nico-pxe` shows EXTERNAL-IP `<pending>`. The other LoadBalancer Services have IPs. What is the most likely cause?**

A. The MetalLB controller couldn't allocate the requested IP: the pinned VIP is outside every IPAddressPool or already in use. Check the pools and the controller logs
B. The BGP session to the ToR is down, so MetalLB can't assign the IP
C. The PXE pod is crashing, and EXTERNAL-IP only appears when pods are healthy
D. Calico isn't running, so Services can't have external IPs

<details>
<summary>Answer</summary>

**A.** The MetalLB controller couldn't allocate the requested IP: the pinned VIP is outside every IPAddressPool or already in use. Check the pools and the controller logs

EXTERNAL-IP is written by MetalLB's controller when it allocates from a pool. That happens whether or not BGP sessions are up and whether or not the pods are healthy. A down BGP session produces an assigned but unreachable IP, not `<pending>`. Calico being down would affect far more than one Service. Because the other Services did get IPs, the problem is specific to this one Service's request.

</details>

**2. `kubectl get svc nico-dhcp` shows the correct pinned EXTERNAL-IP, but BMC DHCP requests relayed from the OOB switches never arrive. Which component's work should you check first?**

A. The speaker's advertisement: BGP sessions to the ToRs, peer addresses and ASNs, and a BGPAdvertisement covering the pool
B. The controller's allocation: IPAddressPool ranges
C. kube-proxy on the control-plane node only
D. The Service type; change it to NodePort

<details>
<summary>Answer</summary>

**A.** The speaker's advertisement: BGP sessions to the ToRs, peer addresses and ASNs, and a BGPAdvertisement covering the pool

The IP was allocated, so the controller did its job. If the routers never learn a route for the VIP, relayed traffic can't reach it. Switching to NodePort would remove the stable VIP that the relay is configured to use.

</details>

**3. In NICo's metallb-config.yaml, what differs between the BGPPeer blocks for different nodes, and what stays the same?**

<details>
<summary>Answer</summary>

The same for all nodes: `myASN` (the cluster-side ASN). Different per node: `peerASN` (that node's ToR ASN), `peerAddress` (that ToR's IP) and the `nodeSelectors` hostname. There is one block per node.

This comes from the Quick Start table for Step 3g.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md), [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md)

<a id="calico-networking"></a>
## 4. Calico networking

*Builds on: CNI (ch. 15), BGP (ch. 9)*

### Before you read

- Calico can advertise each node's pod CIDR to other nodes. Which protocol from Chapter 9 do you think it uses?
- A liveness probe runs a command that normally takes 0.2 s. On some nodes it starts taking 15 s, and the probe timeout is 10 s. What happens to the container?

<details>
<summary>Answers</summary>

- **Calico can advertise each node's pod CIDR to other nodes. Which protocol from Chapter 9 do you think it uses?** BGP. Each calico-node runs the BIRD BGP daemon. By default, the nodes form a full mesh of iBGP sessions and exchange pod routes.
- **A liveness probe runs a command that normally takes 0.2 s. On some nodes it starts taking 15 s, and the probe timeout is 10 s. What happens to the container?** Each probe counts as failed. After `failureThreshold` consecutive failures, the kubelet kills and restarts the container. That can disrupt networking even though the daemon was actually healthy.

</details>

### Explanation

**Calico** is the CNI validated for NICo (v3.28.1). Installing it creates a **calico-node** DaemonSet, so one pod runs on every node. That pod contains:

- **Felix**, the agent that programs the node: routes, iptables or eBPF policy rules, and the pod veth interfaces.
- **BIRD**, a BGP daemon. It announces the node's pod IP blocks to its BGP peers and installs the routes it learns into the kernel.
- **confd**, which generates BIRD's config from Calico's datastore.

By default, every node peers with every other node in a **node-to-node mesh**. You can also peer nodes with ToR switches (route reflectors or ToR peering) using Calico's own BGP resources. Calico can send pod traffic natively, or encapsulate it in IP-in-IP or VXLAN when the fabric doesn't know the pod routes. The default manifest uses IP-in-IP.

To inspect BIRD, use its control client `birdcl` inside calico-node:

```bash
kubectl exec -n kube-system ds/calico-node -c calico-node -- \
  birdcl -s /var/run/calico/bird.ctl show protocols
```

Each `Mesh_...` row should show `Established`.

**Health probes.** The calico-node container has a readiness probe (`calico-node -bird-ready -felix-ready`) and a liveness probe (`calico-node -felix-live -bird-live`). The BIRD checks query the running daemon. The stock v3.28.1 manifest sets `timeoutSeconds: 10` on both probes.

This leads to a general operational failure mode in Calico (the NICo docs don't describe it; it is standard Kubernetes probe behaviour). A node can carry a very large number of addresses and routes, and a site controller that hosts many VIPs and services is a likely candidate. On such a node, BIRD can take longer to answer the probe's query. If it takes longer than `timeoutSeconds`, the kubelet marks calico-node unready or restarts it, even though BGP is working. Restarting BIRD then disturbs the routes you wanted to keep. The fix is to give the probes longer timeouts by raising `timeoutSeconds`, and possibly `periodSeconds` too, so probes don't stack up. This is not a BGP change.

One more point. MetalLB's speaker and Calico's BIRD both speak BGP from the host network. If both must peer with the same ToR from the same node, plan the design carefully (MetalLB's docs cover Calico specifically).

**Analogy.** calico-node is like a branch office with two staff. Felix keeps the local filing (routes and rules) in order, and BIRD phones the other branches to swap address lists. The health probe is head office calling BIRD to ask "are you alive?". If BIRD is busy reading a very long list, the call times out and head office wrongly closes the branch. The analogy breaks down because restarting calico-node is quick and automatic, but it still disturbs routing while it happens.

### Worked example: Inspect calico-node's probes and raise the readiness timeout

**Step 1: Create a cluster with Calico.**

You need a cluster where calico-node runs in `kube-system`. These are steps 1–2 of the chapter's build task, so you can keep this cluster for the build task and the L2 lesson:
```bash
cat > kind-lab.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true
  podSubnet: 192.168.0.0/16
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF
kind create cluster --name lab --config kind-lab.yaml
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.28.1/manifests/calico.yaml
kubectl -n kube-system rollout status ds/calico-node --timeout=300s
```

**Step 2: Check BGP sessions.**

```bash
kubectl exec -n kube-system ds/calico-node -c calico-node -- \
  birdcl -s /var/run/calico/bird.ctl show protocols
```
On a 3-node cluster you'll see two `Mesh_<node-ip>` BGP protocols in state `Established`.

**Step 3: Read and note the current probes.**

```bash
kubectl -n kube-system get ds calico-node \
  -o jsonpath='{.spec.template.spec.containers[0].readinessProbe}{"\n"}{.spec.template.spec.containers[0].livenessProbe}{"\n"}'
```
Note the `exec` commands (`-bird-ready`, `-bird-live`) and write down the current `timeoutSeconds`. With the stock v3.28.1 manifest it is `10` for both probes.

**Step 4: Patch the readiness timeout.**

```bash
kubectl -n kube-system patch ds calico-node --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/timeoutSeconds","value":30}
]'
kubectl -n kube-system rollout status ds/calico-node
```
The DaemonSet replaces each node's pod one at a time. If a manifest you use has no `timeoutSeconds` field, use `"op":"add"` instead of `replace`.

**Step 5: Confirm the change.**

Re-run the jsonpath command from the "Read and note the current probes" step. The readiness `timeoutSeconds` should now be `30`, up from the value you noted, and the liveness probe should be unchanged. Re-run `birdcl ... show protocols` to confirm the sessions came back `Established` after the rollout. On a real site, make this change in the manifest or operator values you deploy Calico with, so a re-apply doesn't undo it.

### Your turn: finish it

The calico-node **liveness** probe currently has `timeoutSeconds: 10`. Complete this JSON patch so that it raises that timeout to 30 seconds.

```text
kubectl -n kube-system patch ds calico-node --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/___/timeoutSeconds","value":___}
]'
```

<details>
<summary>Answer</summary>

`livenessProbe` and `30`:
```bash
kubectl -n kube-system patch ds calico-node --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe/timeoutSeconds","value":30}
]'
```

</details>

### Your turn: on your own

On a site controller node, `kubectl get pods -n kube-system -o wide` shows calico-node with a rising RESTARTS count. `kubectl describe pod` shows events like `Liveness probe failed: command timed out`. `birdcl show protocols`, run between restarts, shows all sessions `Established`. The DaemonSet's probes have `timeoutSeconds: 10`. Diagnose the problem and give the fix.

<details>
<summary>Hint 1</summary>

"command timed out" is different from the probe command returning an error.

</details>

<details>
<summary>Hint 2</summary>

The sessions are up, so BGP is working. What is slow is the health check that queries BIRD.

</details>

<details>
<summary>Hint 3</summary>

Raise `livenessProbe.timeoutSeconds` (and the readiness one too) on the calico-node container in the DaemonSet, to a value clearly above 10.

</details>

<details>
<summary>Answer</summary>

BIRD is healthy but slow to answer the probe's query, probably because the node carries a very large number of addresses or routes. The `-bird-live` check runs longer than 10 s, so the kubelet kills a healthy container. Fix: raise `timeoutSeconds` for the calico-node liveness and readiness probes, for example to 30, with `kubectl -n kube-system patch ds calico-node --type=json -p='[{"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe/timeoutSeconds","value":30},{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/timeoutSeconds","value":30}]'`. Consider raising `periodSeconds` as well. Make the change permanent in the Calico install manifests or values. Don't remove the probes, because you still want real failures to be detected.

</details>

### Explain it

In your own words: Using calico-node as the example, explain why an over-strict health probe can make a system less reliable. Why is raising the timeout a better fix than deleting the probe?

### Check

**1. Inside the calico-node pod, which component distributes pod routes to other nodes over BGP?**

A. BIRD
B. Felix
C. kube-proxy
D. MetalLB speaker

<details>
<summary>Answer</summary>

**A.** BIRD

Felix programs local routes and policy but doesn't speak BGP. kube-proxy handles Service forwarding. The MetalLB speaker announces Service VIPs, not pod CIDRs.

</details>

**2. `birdcl show protocols` shows every Mesh session Established, but calico-node keeps being marked unready with probe timeouts. What should you change?**

A. The probe `timeoutSeconds` on the calico-node container
B. The BGP ASN of the node-to-node mesh
C. The Calico IP pool CIDR
D. Switch Calico from IP-in-IP to VXLAN

<details>
<summary>Answer</summary>

**A.** The probe `timeoutSeconds` on the calico-node container

BGP is working; only the health check is slow. This is the typical sign of BIRD answering slowly on a node with very many addresses or routes. Changing the ASN, the CIDR or the encapsulation wouldn't speed up the probe, and it would disrupt a working network.

</details>

**Sources:** [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="layer-2-advertisement"></a>
## 5. Layer 2 advertisement (ARP)

*Builds on: MetalLB LoadBalancer VIPs (ch. 15), Virtual IP address (VIP) (ch. 14)*

### Before you read

- A client on the same Ethernet segment wants to send to 172.18.255.210, a VIP that isn't configured on any interface. What does the client send first, and who must reply?
- In L2 mode, if three nodes run pods behind the VIP, how many nodes receive the incoming traffic for that VIP?

<details>
<summary>Answers</summary>

- **A client on the same Ethernet segment wants to send to 172.18.255.210, a VIP that isn't configured on any interface. What does the client send first, and who must reply?** An ARP request ("who has 172.18.255.210?") broadcast on the segment. Some host must reply with its MAC. In MetalLB L2 mode, one elected node's speaker replies.
- **In L2 mode, if three nodes run pods behind the VIP, how many nodes receive the incoming traffic for that VIP?** One. The client caches one MAC for the VIP, so all traffic goes to the elected node. kube-proxy then spreads it to pods, possibly on other nodes.

</details>

### Explanation

Not every network can run BGP with your cluster: a laptop, a dev lab or a flat office VLAN can't. For these, MetalLB has **Layer 2 mode**, which you configure with an `L2Advertisement` instead of `BGPPeer` and `BGPAdvertisement`.

How it works:

1. The controller gives the Service a VIP from an `IPAddressPool` that sits **inside the local subnet**.
2. The speakers elect **one node** per VIP.
3. That node's speaker answers ARP requests for the VIP with its own interface MAC (it uses NDP for IPv6). The VIP is never configured on an interface; the speaker just answers ARP for it.
4. Clients send frames to that MAC. On the node, kube-proxy forwards them to a backend pod.
5. If the node dies, another speaker takes over and sends **gratuitous ARP**, an unrequested ARP reply that makes clients update their caches.

What this means in practice:

- **No real load balancing across nodes.** All incoming traffic for one VIP enters through one node.
- **Failover depends on ARP caches**, so expect a few seconds of disruption.
- **The VIP only works on that one L2 segment.** Hosts beyond a router can reach it only if that router has an interface on the same segment and routes traffic to it normally.

In MetalLB v0.14 you can see the elected node in the Service's events: `kubectl describe svc` shows a `nodeAssigned` event from `metallb-speaker` saying "announcing from node ... with protocol layer2". The kind control-plane node carries the `node.kubernetes.io/exclude-from-external-load-balancers` label, so MetalLB picks a worker.

**NICo's position.** The Quick Start says that if your environment doesn't use BGP (local dev, flat network), you comment out the `BGPPeer` and `BGPAdvertisement` sections of `metallb-config.yaml` and uncomment `L2Advertisement`. Preflight checks that **exactly one** mode is active. Production sites use BGP: BMCs, admin networks and tenant VPCs are behind routers, and ARP replies don't cross routers. The same reasoning is why the docs tell tenants on FNN VPCs not to rely on an L2-advertised service VIP.

**Analogy.** L2 mode is like someone in an open-plan office who shouts "that's me!" whenever anyone calls the name of a colleague who isn't at their desk, then passes the message on. This works for everyone in the room. Nobody in another building can hear the call at all, which is why routed networks need BGP instead.

### Worked example: Find which node owns an L2 VIP

**Step 1: Get a cluster with MetalLB in L2 mode.**

This example needs the cluster from the chapter's build task. **Complete build-task steps 1–5 now** (kind + Calico, MetalLB, `lab-pool` + `L2Advertisement`, Service `web` on a pinned VIP). If you already built the `lab` cluster in the Calico lesson, start at build-task step 3. Then make sure `VIP` is set in this shell:
```bash
echo $VIP   # e.g. 172.18.255.210; if empty, re-run the PFX/VIP lines from build-task steps 4–5
kubectl get svc web
```

**Step 2: Ask Kubernetes which node was elected.**

```bash
kubectl describe svc web | grep -i announcing
```
Expect something like `announcing from node "lab-worker" with protocol "layer2"`.

**Step 3: Trigger ARP from a client on the same segment.**

```bash
docker run --rm --network kind nicolaka/netshoot \
  sh -c "curl -s -o /dev/null -w '%{http_code}\n' http://$VIP; ip neigh show $VIP"
```
You get `200`, then a line like `172.18.255.210 dev eth0 lladdr 02:42:ac:12:00:03 REACHABLE`.

**Step 4: Match the MAC to a node.**

```bash
for n in $(kind get nodes --name lab); do
  echo "$n $(docker exec $n cat /sys/class/net/eth0/address)"
done
```
The node whose eth0 MAC equals the `lladdr` above is the one answering ARP. It should match the `announcing from node` event.

### Your turn: finish it

Complete the advertisement that switches the pool `lab-pool` to Layer 2 mode.

```text
apiVersion: metallb.io/v1beta1
kind: ___
metadata:
  name: lab-l2
  namespace: metallb-system
spec:
  ipAddressPools:
    - ___
```

<details>
<summary>Answer</summary>

`L2Advertisement` and `lab-pool`:
```yaml
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: lab-l2
  namespace: metallb-system
spec:
  ipAddressPools:
    - lab-pool
```

</details>

### Your turn: on your own

In your lab, simulate failure of the node that owns the VIP. Predict what happens to the client's ARP entry, then test it. After that, explain in two sentences why you would not use this mode for NICo's nico-dhcp VIP on a production site.

<details>
<summary>Hint 1</summary>

`docker stop <owning-node-container>` simulates node failure. Wait 10–30 s.

</details>

<details>
<summary>Hint 2</summary>

Repeat the netshoot `curl` + `ip neigh show` command and compare the MAC. Each netshoot run is a fresh container with an empty ARP cache, so it will send a new ARP request.

</details>

<details>
<summary>Hint 3</summary>

For production: where are the BMCs whose DHCP traffic gets relayed? Are they on the same L2 segment as the site controller nodes?

</details>

<details>
<summary>Answer</summary>

After the owning node stops, another node's speaker takes over the VIP and announces it with gratuitous ARP. The new curl still returns 200 once pods are running on the surviving nodes, and `ip neigh` shows a different node's MAC. `kubectl describe svc web` shows a new `announcing from node` event. Restart the node afterwards with `docker start`. For production: relayed DHCP from the OOB switches, and traffic from admin networks and tenant VPCs, arrives through routers. ARP answers never leave the site controller's local segment, so those networks can only reach the VIP if it is announced as a route. That is why NICo's reference design uses MetalLB BGP mode with VIPs advertised to the DPU uplinks or ToRs, and keeps L2 mode for dev and flat networks.

</details>

### Explain it

In your own words: Using what ARP actually does, explain why a MetalLB L2 VIP is reachable from a container on the same Docker bridge but would not be reachable from a tenant VPC on the far side of a router.

### Check

**1. In MetalLB Layer 2 mode with 3 healthy speaker nodes, how is incoming traffic to one VIP distributed?**

A. All of it arrives at one elected node, which then forwards to pods via kube-proxy
B. The switch spreads it evenly across all three nodes with ECMP
C. Each client is ARP-answered by a different node in round-robin
D. It is sent to the control-plane node, which proxies to workers

<details>
<summary>Answer</summary>

**A.** All of it arrives at one elected node, which then forwards to pods via kube-proxy

One node owns each VIP and answers ARP for it. ECMP spreading across nodes happens in BGP mode, not L2 mode. Speakers don't take turns answering ARP, and in kind the control-plane node is actually excluded.

</details>

**2. NICo preflight rejects a metallb-config.yaml that has both an active BGPAdvertisement and an active L2Advertisement. What does it require?**

A. Exactly one advertisement mode active: BGP or L2, not both
B. Both modes, so that L2 can act as a fallback
C. L2 mode only, because preflight runs on a laptop
D. No advertisement at all; setup.sh creates it

<details>
<summary>Answer</summary>

**A.** Exactly one advertisement mode active: BGP or L2, not both

The preflight table lists "exactly one advertisement mode active (BGP or L2, not both)". The Quick Start tells you to comment out the BGP sections when you enable L2.

</details>

**3. When the VIP owner fails in L2 mode, how do clients learn about the new owner?**

<details>
<summary>Answer</summary>

The new owner's speaker sends gratuitous ARP for the VIP, so clients and switches update their MAC caches. Cache entries that age out are also refreshed by new ARP requests.

L2 mode has no routes to withdraw. Failover depends entirely on updating ARP and MAC tables.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md)

<a id="build-task"></a>
## Build task: A laptop site-controller network: kind + Calico + MetalLB L2 with a pinned VIP

**Goal:** Build a 3-node kind cluster that uses Calico as its CNI instead of kind's default. Install MetalLB v0.14.5 in Layer 2 mode with an address pool on the kind Docker network. Expose a web Deployment through a LoadBalancer Service pinned to a specific VIP. Then prove from a container outside the cluster that the VIP answers, and identify which node answers ARP for it.

**Why it matters for NICo:** This is a scaled-down version of NICo's networking prerequisites. Calico is the validated CNI, MetalLB provides the VIPs, and NICo pins a stable VIP for each service because DHCP relays, DNS and PXE point at them. You follow the same order as on a real site: Calico first, then MetalLB, then pools and advertisement, then pinned VIPs, then checking for `<pending>`. The difference is that you use the L2 mode NICo recommends for dev and flat networks, not BGP to ToRs.

**You need:**

- Linux or macOS with Docker (Docker Desktop, Docker Engine or Colima) and 4+ GB of free RAM
- kind (v0.20+) and kubectl
- Internet access to pull the Calico and MetalLB manifests and the nginx and nicolaka/netshoot images
- Optional for the stretch goal: Tilt

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Create a kind cluster with no default CNI</summary>

Skip this step if you already created the `lab` cluster in the Calico lesson.
```bash
cat > kind-lab.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true
  podSubnet: 192.168.0.0/16
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF
kind create cluster --name lab --config kind-lab.yaml
kubectl get nodes
```
All nodes show `NotReady`. There is no CNI, so there is no pod network yet, as the CNI lesson predicted.

</details>

<details>
<summary>Step 2: Install Calico v3.28.1 and check BIRD</summary>

```bash
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.28.1/manifests/calico.yaml
kubectl -n kube-system rollout status ds/calico-node --timeout=300s
kubectl get nodes
kubectl exec -n kube-system ds/calico-node -c calico-node -- \
  birdcl -s /var/run/calico/bird.ctl show protocols
```
The nodes become `Ready`, and you see two `Mesh_...` BGP sessions in state `Established`.

</details>

<details>
<summary>Step 3: Install MetalLB v0.14.5</summary>

```bash
kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.14.5/config/manifests/metallb-native.yaml
kubectl wait -n metallb-system --for=condition=ready pod -l app=metallb --timeout=180s
kubectl get pods -n metallb-system -o wide
```
You should see one controller and one speaker per node.

</details>

<details>
<summary>Step 4: Create an address pool on the kind network plus an L2Advertisement</summary>

```bash
SUBNET=$(docker network inspect kind -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | tr ' ' '\n' | grep -v : | head -1)
echo "kind IPv4 subnet: $SUBNET"   # e.g. 172.18.0.0/16
PFX=$(echo "$SUBNET" | cut -d. -f1-2)
cat > metallb-lab.yaml <<EOF
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: lab-pool
  namespace: metallb-system
spec:
  addresses:
    - ${PFX}.255.200-${PFX}.255.250
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: lab-l2
  namespace: metallb-system
spec:
  ipAddressPools:
    - lab-pool
EOF
kubectl apply -f metallb-lab.yaml
kubectl get ipaddresspool,l2advertisement -n metallb-system
```

</details>

<details>
<summary>Step 5: Deploy a service on a pinned VIP</summary>

```bash
export VIP=${PFX}.255.210
kubectl create deployment web --image=nginx --replicas=2
cat > web-svc.yaml <<EOF
apiVersion: v1
kind: Service
metadata:
  name: web
  annotations:
    metallb.universe.tf/loadBalancerIPs: ${VIP}
spec:
  type: LoadBalancer
  selector:
    app: web
  ports:
    - port: 80
      targetPort: 80
EOF
kubectl apply -f web-svc.yaml
kubectl get svc web
```
EXTERNAL-IP must equal `$VIP`, not `<pending>`. If you delete and re-apply the Service, you get the same IP again. That repeatability is why NICo pins VIPs.

</details>

<details>
<summary>Step 6: Test from outside the cluster and find the ARP owner</summary>

```bash
docker run --rm --network kind nicolaka/netshoot \
  sh -c "curl -s -o /dev/null -w '%{http_code}\n' http://$VIP; ip neigh show $VIP"
kubectl describe svc web | grep -i announcing
for n in $(kind get nodes --name lab); do
  echo "$n $(docker exec $n cat /sys/class/net/eth0/address)"
done
```
The client container is not part of Kubernetes. It only shares the L2 segment (the `kind` bridge), the way a laptop on a flat lab VLAN would.

</details>

**Check it works:** `docker run --rm --network kind nicolaka/netshoot sh -c "curl -s -o /dev/null -w '%{http_code}\n' http://$VIP; ip neigh show $VIP"` prints `200` and then a line with an `lladdr` MAC. That MAC equals the eth0 MAC of the worker named in `kubectl describe svc web` (`announcing from node "lab-worker..." with protocol "layer2"`). Also, `kubectl get svc web` shows EXTERNAL-IP equal to `$VIP`, and `birdcl ... show protocols` shows Established mesh sessions.

<details>
<summary>If you get stuck</summary>

- Nodes stay NotReady after you apply Calico: wait a few minutes for image pulls, then check `kubectl -n kube-system get pods` and `kubectl -n kube-system logs ds/calico-node -c calico-node`. If Felix refuses to start because of reverse-path filtering, `kubectl -n kube-system set env ds/calico-node FELIX_IGNORELOOSERPF=true` fixes it on some hosts.
- EXTERNAL-IP stays `<pending>`: that's an allocation problem, so BGP is irrelevant here. The pinned IP must be inside `lab-pool` and not used by another Service. Check `echo $VIP` (shell variables are lost in a new terminal) and `kubectl -n metallb-system logs deploy/controller`.
- The IP is assigned but curl gets no answer: that's an advertisement problem. Check that the `L2Advertisement` exists and names `lab-pool`, that the speaker pods are Running, and that the `web` pods are Ready.
- The subnet command printed nothing or something odd: run `docker network inspect kind` and pick the IPv4 subnet by hand. If it isn't a /16, choose pool addresses near the top of whatever range it is.
- curl hangs or times out: make sure you ran the client with `--network kind`. On macOS, the host itself can't reach kind's bridge IPs, which is why this lab tests from a container on that network.
- `birdcl` not found or wrong socket: confirm you passed `-c calico-node` and the socket path `/var/run/calico/bird.ctl`, and check that calico-node is Ready.

</details>

**Stretch goal:** Add Tilt to the inner loop. Write a small Python HTTP app with a Dockerfile, a Deployment and a `type: LoadBalancer` Service whose `metallb.universe.tf/loadBalancerIPs` annotation is set to `${PFX}.255.220`. Write a Tiltfile with `docker_build`, `k8s_yaml` and `k8s_resource`, then run `tilt up` against `kind-lab`. Change the response text, save, and use the netshoot curl to confirm that the VIP serves the new version without any manual docker or kubectl command. Then simulate failure of the VIP's owner node with `docker stop`, and record how the ARP owner changes.

## Review notes

The draft was rewritten once using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (Layer 2 advertisement (ARP)): The independent problem's answer says to 'Restart the node afterwards with `docker start`' as if the cluster will recover. Kind node containers often don't survive a stop/start: Docker can give the released IP to another container on the kind network while the node is down (for example the `--rm` netshoot clients the exercise has learners run). The node then returns on a different IP and its kubelet and Calico BGP sessions break. Learners who keep using `lab` for the Tilt stretch goal (which also includes this failover test) may end up with a broken cluster. *Fix:* Add a note that a stopped kind node may not rejoin cleanly after `docker start`. Do the failover test as the last step, and if nodes stay NotReady or Mesh sessions don't re-establish, recreate the cluster with `kind delete cluster --name lab` and build-task steps 1–5.

---

[← 14-kubernetes-basics.md](14-kubernetes-basics.md) · [16-scale-sizing.md →](16-scale-sizing.md)
