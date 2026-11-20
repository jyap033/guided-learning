# NVIDIA NICo (NVIDIA Infra Controller): curriculum

**Goal:** Understand, deploy and operate NVIDIA NICo well enough to provision bare-metal machines through its APIs.

49 chapters, 318 concepts, ordered so that every concept comes after its prerequisites. Generated from 36 docs pages of [dsx-ai-factory/infra-controller](https://github.com/dsx-ai-factory/infra-controller) at `38a79e71dff4` by `claude-code`. See [mindmap.md](./mindmap.md) for the overview and [report.md](./report.md) for checks.

> This is AI-generated and not yet reviewed. Definitions are summaries: check them against the linked docs pages.

**Assumed starting knowledge:** Basic programming in any language; Basic use of a terminal; Using a computer and a web browser.

## Contents


**Foundations**

1. [Hardware Basics · Data & Formats](#chapter-1) (10)
2. [Software & Linux Basics](#chapter-2) (6)
3. [Networking Basics](#chapter-3) (6)

**NICo Architecture**

4. [State Machine Framework](#chapter-4) (7)

**Hardware & OOB Management**

5. [UEFI & Firmware · NICo Architecture](#chapter-5) (5)
6. [BMC & Redfish](#chapter-6) (6)
7. [BlueField DPU · Hardware & OOB Management](#chapter-7) (5)

**Networking & Isolation**

8. [Boot & Network Services · UEFI & Firmware](#chapter-8) (8)
9. [Underlay & BGP](#chapter-9) (6)
10. [DPU Networking · Addressing & Pools](#chapter-10) (6)
11. [VXLAN/EVPN Overlay](#chapter-11) (7)
12. [Boot & Network Services](#chapter-12) (5)

**Kubernetes & Deployment**

13. [Building Images](#chapter-13) (10)
14. [Kubernetes Basics](#chapter-14) (8)
15. [Cluster Networking](#chapter-15) (5)
16. [Scale & Sizing](#chapter-16) (7)
17. [Helm & GitOps · Installation & Setup](#chapter-17) (7)

**Security & Identity**

18. [Cryptography](#chapter-18) (6)
19. [PKI & Certificates · Authentication & Identity](#chapter-19) (8)
20. [Credentials & Secrets · Security & Identity](#chapter-20) (6)
21. [Authentication & Identity](#chapter-21) (5)

**Host Lifecycle**

22. [Discovery & Ingestion](#chapter-22) (8)

**NICo Architecture**

23. [NICo Architecture · BlueField DPU](#chapter-23) (6)

**Networking & Isolation**

24. [GPU Fabrics](#chapter-24) (5)

**Health & Operations**

25. [Observability](#chapter-25) (5)
26. [Console Access](#chapter-26) (7)

**DOCA Platform Framework**

27. [DPF Setup](#chapter-27) (7)

**Rack-Scale Systems**

28. [GB200 Rack Hardware](#chapter-28) (5)

**Networking & Isolation**

29. [VPCs & Segments](#chapter-29) (7)

**NICo Architecture**

30. [State Machine Framework · GPU Fabrics](#chapter-30) (10)
31. [Control Plane Services · State Machine Framework](#chapter-31) (9)

**Hardware & OOB Management**

32. [BMC & Redfish (part 2)](#chapter-32) (5)

**Kubernetes & Deployment**

33. [Installation & Setup](#chapter-33) (5)

**Security & Identity**

34. [Credentials & Secrets · SuperNIC Lockdown](#chapter-34) (5)

**Host Lifecycle**

35. [SuperNIC Lockdown · Validation & Updates](#chapter-35) (5)

**Health & Operations**

36. [Hardware Monitoring](#chapter-36) (5)

**DOCA Platform Framework**

37. [DPF Custom Resources · Rollout & Reprovisioning](#chapter-37) (5)

**Host Lifecycle**

38. [Discovery & Ingestion (part 2)](#chapter-38) (7)
39. [Validation & Updates · Tenants & Instances](#chapter-39) (7)
40. [Managed Host States](#chapter-40) (9)

**NICo Architecture**

41. [Host & DPU Agents](#chapter-41) (5)

**Kubernetes & Deployment**

42. [Scale & Sizing · SuperNIC Lockdown](#chapter-42) (5)

**Host Lifecycle**

43. [NIC Firmware Recovery](#chapter-43) (7)

**Health & Operations**

44. [Health Model](#chapter-44) (8)

**Host Lifecycle**

45. [Hardware Monitoring · Validation & Updates](#chapter-45) (5)

**DOCA Platform Framework**

46. [Tenants & Instances · DPF Custom Resources](#chapter-46) (5)

**Rack-Scale Systems**

47. [Rack & Device States](#chapter-47) (6)
48. [Rack Maintenance](#chapter-48) (8)
49. [GB200 Rack Hardware (part 2)](#chapter-49) (8)

<a id="chapter-1"></a>
## Chapter 1: Hardware Basics · Data & Formats

*Part: Foundations*

### TOML

A configuration file format built from tables and key-value pairs. NICo's site config is written in it.

*conceptual* · from the docs

- **Unlocks:** siteConfig (site TOML configuration) (ch. 33)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### Protocol Buffers

A schema language and serialization format that NICo uses to define API messages such as InfinibandInterface.

*conceptual* · from the docs · also called Protocol Buffers (protobuf), protobuf, oneof

- **Unlocks:** mTLS / gRPC (ch. 19)
- **Docs:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md), [architecture/state_machines/rack.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rack.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### Relational databases and SQL

Databases that store data in tables and are queried with SQL.

*conceptual* · background, 1 level below the docs

- **Unlocks:** PostgreSQL (Zalando operator) (ch. 17)

### YAML

A human-readable data format that uses indentation for structure.

*conceptual* · background, 1 level below the docs

- **Unlocks:** Helm and helmfile (ch. 17)

### MAC address

The hardware address of a network interface. NICo uses MACs to identify interfaces and BMCs, to pair DPUs with hosts, and as the key for storing BMC credentials.

*conceptual* · from the docs · also called BMC MAC, NVOS MAC, MAC Address

- **Unlocks:** DPU-host pairing (ch. 22), Expected Machines Manifest (ch. 22), UEFI device path (ch. 5)
- **Docs:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [architecture/health_aggregation.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health_aggregation.md), [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md), [architecture/state_machines/switch_configure_certificate.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch_configure_certificate.md), [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md)

### PCIe device

A hardware component attached over the PCI Express bus, such as a NIC, DPU or GPU. Redfish exposes PCIe devices with serial and part numbers, and NICo uses them as the primary path for DPU pairing.

*conceptual* · from the docs

- **Unlocks:** DPU-host pairing (ch. 22), Node Feature Discovery (NFD) (ch. 27), UEFI device path (ch. 5), rshim (ch. 7), PCI device and slot address (ch. 1)
- **Docs:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [architecture/networking_integrations.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/networking_integrations.md)

### NUMA node

A CPU and memory locality domain. The NUMA node a device is attached to affects performance between that device and GPUs.

*conceptual* · from the docs

- **Docs:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md)

### CPU architectures (amd64 vs arm64)

Different processor instruction sets. A binary built for one cannot run natively on the other.

*conceptual* · background, 1 level below the docs

- **Unlocks:** Cross-architecture emulation (binfmt/QEMU) (ch. 13)

### Server hardware basics

How a physical server is built: CPU, memory, drives, NICs and firmware, and how servers sit in datacenter racks.

*conceptual* · background, 1 level below the docs

- **Unlocks:** Bare-metal lifecycle management (ch. 5), UEFI firmware and Secure Boot (ch. 5), Secure Erase (ch. 22), Network interface card (NIC) (ch. 2)

### PCI device and slot address

An address such as 0000:ca:00.0 that identifies a PCI device. NICo sorts by it to map tenant selections to hardware deterministically.

*conceptual* · from the docs

- **Needs:** PCIe device (ch. 1)
- **Unlocks:** InfiniBand device (NIC port as device) (ch. 30), PF and VF (SR-IOV) (ch. 10)
- **Docs:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md)

<a id="chapter-2"></a>
## Chapter 2: Software & Linux Basics

*Part: Foundations*

Builds on chapters 1.

### Network interface card (NIC)

The hardware that connects a server to a network.

*conceptual* · background, 1 level below the docs

- **Needs:** Server hardware basics (ch. 1)
- **Unlocks:** Layer 2 Ethernet networking (ch. 3)

### Asynchronous programming (async/await)

A programming style where tasks pause while waiting for I/O, so a small number of threads can run many tasks.

*conceptual* · background, 1 level below the docs

- **Unlocks:** Tokio worker threads (ch. 16)

### Git version control

Tracking file changes in repositories with commits and branches.

*procedural* · background, 1 level below the docs

- **Unlocks:** GitOps with ArgoCD (ch. 17)

### Linux system administration basics

Configuring users, packages, files and services on a Linux OS.

*conceptual* · background, 1 level below the docs

- **Unlocks:** Containers and container images (ch. 2), Linux memory and cgroups (ch. 2)

### Containers and container images

Packaged application filesystems that run as isolated processes, built from Dockerfiles.

*conceptual* · background, 1 level below the docs · also called Containers

- **Needs:** Linux system administration basics (ch. 2)
- **Unlocks:** Kubernetes (ch. 14), Docker BuildKit and Buildx (ch. 13), Container registry (ch. 13)

### Linux memory and cgroups

How Linux tracks resident memory and page cache, and how cgroups cap and account for the resources of a group of processes.

*conceptual* · background, 1 level below the docs

- **Needs:** Linux system administration basics (ch. 2)
- **Unlocks:** Kubelet working set and OOM kill (ch. 16)

<a id="chapter-3"></a>
## Chapter 3: Networking Basics

*Part: Foundations*

Builds on chapters 2.

### HTTP and web APIs

How clients call servers over HTTP, including headers, status codes and tokens.

*conceptual* · background, 1 level below the docs · also called REST APIs and HTTPS

- **Unlocks:** Redfish API (ch. 6), OIDC / JWT authentication (Keycloak) (ch. 19), Microservices architecture (ch. 4)

### IP addressing basics

How IP addresses identify hosts on a network.

*conceptual* · background, 1 level below the docs

- **Unlocks:** Virtual IP address (VIP) (ch. 14), IP networking fundamentals (ch. 3)

### Layer 2 Ethernet networking

How switches forward frames by MAC address within a local network segment.

*conceptual* · background, 1 level below the docs

- **Needs:** Network interface card (NIC) (ch. 2)
- **Unlocks:** VLAN (ch. 10), IP networking fundamentals (ch. 3)

### IP networking fundamentals

How IP addresses, subnets, switches and routers move packets between machines on Ethernet networks.

*conceptual* · background, 1 level below the docs · also called Computer networking basics (IP, subnets)

- **Needs:** Layer 2 Ethernet networking (ch. 3), IP addressing basics (ch. 3)
- **Unlocks:** Baseboard Management Controller (BMC) (ch. 6), DNS (authoritative and recursive) (ch. 8), LLDP (ch. 22), Underlay and overlay networks (ch. 9), VRF (ch. 11), CIDR prefixes and /31 point-to-point subnets (ch. 3), CNI (ch. 15), Firewall rules (ch. 3)

### CIDR prefixes and /31 point-to-point subnets

CIDR notation gives the size of an IP block. A /31 holds exactly two addresses for a point-to-point link, and a /32 is a single host address such as a loopback.

*conceptual* · from the docs · also called IP subnets and CIDR notation

- **Needs:** IP networking fundamentals (ch. 3)
- **Unlocks:** IP address pools (ch. 10), BGP (ch. 9), DHCP (ch. 8), BMC network IP addressing (ch. 10), NICo resource pools (ch. 12)
- **Docs:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

### Firewall rules

Rules that allow or deny traffic based on addresses, ports and protocols.

*conceptual* · background, 1 level below the docs

- **Needs:** IP networking fundamentals (ch. 3)
- **Unlocks:** Network security group (ch. 38)

<a id="chapter-4"></a>
## Chapter 4: State Machine Framework

*Part: NICo Architecture*

Builds on chapters 3.

### Microservices architecture

Building a system as many small, independently deployed services that talk over the network.

*conceptual* · background, 1 level below the docs

- **Needs:** HTTP and web APIs (ch. 3)
- **Unlocks:** Site Controller (ch. 18)

### Temporal workflow engine

A durable workflow orchestration engine. NICo REST uses it for multi-step operations such as provisioning and release, and the Site Agent connects through it. It needs the cloud and site namespaces plus one per site UUID.

*conceptual* · from the docs · also called Temporal, Temporal namespace, Cloud workflow, Site workflow

- **Unlocks:** Site Agent (ch. 31), GB200 NVL72 rack-scale management (NICo Flow) (ch. 49)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### Rate limiting (GCRA token bucket)

An algorithm that caps the sustained request rate and allows short bursts. The DPU agent uses it for IMDS identity requests.

*conceptual* · from the docs

- **Docs:** [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md)

### Database transaction

A group of database writes that commit or roll back together. NICo keeps transactions short and never holds one open across external calls.

*conceptual* · from the docs · also called Database Transaction, atomic update

- **Unlocks:** State machine (resource lifecycle) (ch. 30), Optimistic concurrency / stale-write protection (ch. 4), WorkLock lease and fencing (ch. 4)
- **Docs:** [architecture/state_handling.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_handling.md), [architecture/state_machines/power_shelf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/power_shelf.md), [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md)

### Idempotency

An operation is idempotent if repeating it gives the same result as doing it once. NICo requires handlers and external effects to be safe to retry, because exactly-once execution is not guaranteed.

*conceptual* · from the docs · also called idempotent, non-idempotent

- **Unlocks:** Recovery point and crash-window reconciliation (ch. 30), Submission Outcome Semantics (ch. 48), setup.sh orchestrator (ch. 17), Firmware Supervisor and Receipt (ch. 35)
- **Docs:** [architecture/state_handling.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_handling.md), [architecture/state_machines/switch_configure_certificate.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch_configure_certificate.md), [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md)

### Optimistic concurrency / stale-write protection

Writing state only if its stored version still matches the version that was read. NICo rejects stale writes this way and invalidates that iteration.

*conceptual* · from the docs · also called Optimistic concurrency with versions

- **Needs:** Database transaction (ch. 4)
- **Unlocks:** Iteration invalidation (ch. 31), Key group synchronization (ch. 36)
- **Docs:** [architecture/state_handling.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_handling.md), [architecture/key_group_sync.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/key_group_sync.md)

### WorkLock lease and fencing

An expiring, auto-renewed database lease for coordinating long-running work. Protected writes must call fence_transaction in the same transaction to prove the worker still owns the lease.

*conceptual* · from the docs · also called Leader lease / work lock

- **Needs:** Database transaction (ch. 4)
- **Unlocks:** Switch reachability monitor (ch. 49), Operator Reconciliation (ch. 43)
- **Docs:** [architecture/state_handling.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_handling.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

<a id="chapter-5"></a>
## Chapter 5: UEFI & Firmware · NICo Architecture

*Part: Hardware & OOB Management*

Builds on chapters 1.

### Bare-metal lifecycle management

Managing physical servers from the moment they are racked: discovery, validation, provisioning to tenants, ongoing operation, and cleanup for reuse. The goal is for physical machines to behave like cloud instances.

*conceptual* · from the docs

- **Needs:** Server hardware basics (ch. 1)
- **Unlocks:** Day 0 / Day 1 / Day 2 lifecycle (ch. 5), NICo (NVIDIA Infra Controller) (ch. 23)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md)

### Day 0 / Day 1 / Day 2 lifecycle

NICo's three lifecycle phases. Day 0 covers bring-up, discovery and ingestion. Day 1 covers isolation, lockdown and provisioning. Day 2 covers operations, monitoring, upgrades and tenant transitions.

*conceptual* · from the docs · also called Day 0 vs Day 1 configuration

- **Needs:** Bare-metal lifecycle management (ch. 5)
- **Unlocks:** Machine identity (JWT-SVID issuance) (ch. 43)
- **Docs:** [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md), [getting-started/installation-options/day0-credential-store.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-credential-store.md)

### UEFI firmware and Secure Boot

UEFI is the server firmware that initializes hardware and picks the boot device. Secure Boot only allows signed bootloaders and kernels to run. NICo manages UEFI settings, boot order and passwords.

*conceptual* · from the docs · also called Secure Boot, UEFI Secure Boot, Boot Order, SetBootOrder

- **Needs:** Server hardware basics (ch. 1)
- **Unlocks:** PXE / iPXE boot (ch. 12), UEFI lockdown (ch. 8), Firmware baseline enforcement (ch. 35), TPM and Measured Boot attestation (ch. 20), Factory default credentials (ch. 20), UEFI device path (ch. 5), Boot order and boot source override (ch. 8), DMI Platform Identity (ch. 5)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md), [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

### UEFI device path

A UEFI string that describes the hardware path to a device, e.g. PciRoot(...)/Pci(...)/MAC(...). NICo parses it to order interfaces and to extract MAC addresses.

*conceptual* · from the docs

- **Needs:** UEFI firmware and Secure Boot (ch. 5), PCIe device (ch. 1), MAC address (ch. 1)
- **Docs:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

### DMI Platform Identity

The system vendor and product name that the host firmware reports. NIC firmware policy uses them to identify the platform.

*conceptual* · from the docs

- **Needs:** UEFI firmware and Secure Boot (ch. 5)
- **Unlocks:** NIC Firmware Baseline Policy (ch. 36), Machine ID (ch. 38)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

<a id="chapter-6"></a>
## Chapter 6: BMC & Redfish

*Part: Hardware & OOB Management*

Builds on chapters 3.

### Baseboard Management Controller (BMC)

A small, independent controller on a server or DPU that allows remote power control, monitoring and firmware updates over a management network, even when the main OS is down.

*conceptual* · from the docs · also called BMC, BMC endpoint, BMC credentials, site-wide BMC root

- **Needs:** IP networking fundamentals (ch. 3)
- **Unlocks:** Redfish API (ch. 6), Out-of-band (OOB) management (ch. 7), Serial-over-LAN and SSH Console Service (ch. 26), Machine-a-tron (ch. 16), BMC network IP addressing (ch. 10), Out-of-band (OOB) management network (ch. 8), Site-wide BMC root credential (ch. 20), Factory default credentials (ch. 20), BlueField DPU (ch. 7), NVLink switch tray (ch. 28), Power shelf (ch. 28)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md), [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

### Redfish API

A standard REST/HTTPS API exposed by BMCs for out-of-band management: power control, boot order, firmware inventory and update, sensors, and Serial-over-LAN. NICo talks to BMCs only through Redfish.

*conceptual* · from the docs · also called Redfish, installViaRedfish, DMTF Redfish, libredfish

- **Needs:** Baseboard Management Controller (BMC) (ch. 6), HTTP and web APIs (ch. 3)
- **Unlocks:** Hardware discovery and ingestion (ch. 38), DPFOperatorConfig (ch. 37), Power control reset types (ch. 6), Rack Management Service (RMS) (ch. 29), Redfish resource tree (Systems, Chassis, Managers) (ch. 6), Redfish Task Service (ch. 32), BMC credential rotation (ch. 20), UEFI/BIOS settings (ch. 8), SPDM attestation (ch. 20)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md)

### Power control reset types

The Redfish reset actions used to power-cycle hosts and DPUs. They range from a graceful restart to a full AC power cycle.

*conceptual* · from the docs

- **Needs:** Redfish API (ch. 6)
- **Unlocks:** Preingestion Manager (ch. 38), Host Reprovision (ch. 40)
- **Docs:** [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [architecture/backends/rms.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/backends/rms.md)

### Redfish resource tree (Systems, Chassis, Managers)

Redfish arranges resources in a hierarchy under /redfish/v1. Systems are the computers, Chassis are the physical enclosures and cards, and Managers are the BMCs. Resources link to each other with @odata.id references.

*conceptual* · from the docs

- **Needs:** Redfish API (ch. 6)
- **Unlocks:** Redfish vendor detection and OEM extensions (ch. 6), DPU-host pairing (ch. 22), Machine ID (ch. 38), Firmware inventory and update (ch. 32), BMC sensors and event logs (ch. 26)
- **Docs:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

### Redfish vendor detection and OEM extensions

NICo reads the Vendor field from the service root and uses it to choose vendor-specific endpoints and behavior (Dell, HPE, Supermicro, Lenovo, Viking, NVIDIA). Vendors also add non-standard fields and actions under an 'Oem' section.

*conceptual* · from the docs

- **Needs:** Redfish resource tree (Systems, Chassis, Managers) (ch. 6)
- **Unlocks:** libredfish and nv-redfish (ch. 6), rshim (ch. 7)
- **Docs:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

### libredfish and nv-redfish

The two Rust Redfish client libraries NICo uses. libredfish has vendor-specific implementations. nv-redfish generates typed code from the Redfish schema and is gradually replacing libredfish.

*conceptual* · from the docs · also called libredfish, nv-redfish, bmc-explorer

- **Needs:** Redfish vendor detection and OEM extensions (ch. 6)
- **Docs:** [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

<a id="chapter-7"></a>
## Chapter 7: BlueField DPU · Hardware & OOB Management

*Part: Hardware & OOB Management*

Builds on chapters 1, 6.

### BlueField DPU

An NVIDIA SmartNIC with its own ARM CPU, OS and BMC. It sits in the server and handles networking independently of the host. In NICo it is the trust anchor and the point where network isolation is enforced.

*conceptual* · from the docs · also called Data Processing Unit (DPU), DPU, BlueField, BlueField-3 DPU

- **Needs:** Baseboard Management Controller (BMC) (ch. 6)
- **Unlocks:** DPU mode vs NIC mode (ch. 12), Zero-trust host model (ch. 23), Host-Based Networking (HBN) (ch. 29), DPU BFB (ch. 13), Scalable Functions (SF) (ch. 10), rshim (ch. 7), Static network fabric principle (ch. 24), iPXE-based DPU provisioning (ch. 27), Underlay and HostInband network segments (ch. 12), Top-of-rack (ToR) uplink (ch. 9), DPA (Data Path Accelerator) (ch. 7), DOCA (ch. 28)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/operational-principles.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/operational-principles.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md), [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

### DPA (Data Path Accelerator)

A NIC subsystem with its own agents and firmware policies. Legacy DPA firmware paths must not overlap with the generic NIC firmware engine.

*conceptual* · from the docs

- **Needs:** BlueField DPU (ch. 7)
- **Unlocks:** DPA Interface (ch. 34)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### rshim

A BlueField interface that lets the host (or the BMC) reach the DPU's console and boot path over PCIe. NICo enables it with NVIDIA OEM Redfish actions.

*conceptual* · from the docs · also called Rshim, EnableRshim

- **Needs:** BlueField DPU (ch. 7), PCIe device (ch. 1), Redfish vendor detection and OEM extensions (ch. 6)
- **Docs:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Out-of-band (OOB) management

Managing and monitoring hardware over a separate management network through BMCs, without going through the host OS. NICo relies only on out-of-band paths so a compromised host cannot spoof or block monitoring.

*conceptual* · from the docs · also called OOB, out of band, Out-of-Band Management (OOB), IPMI

- **Needs:** Baseboard Management Controller (BMC) (ch. 6)
- **Unlocks:** Zero-trust host model (ch. 23), Underlay and HostInband network segments (ch. 12), Out-of-Band (OOB) Interface (ch. 7)
- **Docs:** [overview/operational-principles.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/operational-principles.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

### Out-of-Band (OOB) Interface

A management network interface that is separate from the data network.

*conceptual* · from the docs

- **Needs:** Out-of-band (OOB) management (ch. 7)
- **Unlocks:** Decommissioning (ch. 40)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

<a id="chapter-8"></a>
## Chapter 8: Boot & Network Services · UEFI & Firmware

*Part: Networking & Isolation*

Builds on chapters 3, 5, 6.

### UEFI/BIOS settings

Firmware configuration of a server. Redfish lets clients read BIOS attributes and write them as pending changes that take effect on the next reboot. NICo uses this for things like enabling SR-IOV.

*conceptual* · from the docs · also called UEFI/BIOS Configuration

- **Needs:** Redfish API (ch. 6)
- **Unlocks:** Boot order and boot source override (ch. 8), UEFI lockdown (ch. 8)
- **Docs:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### UEFI lockdown

Locking UEFI/BIOS settings while a tenant has the host, together with disabling in-band host-to-BMC access, so the tenant cannot change firmware configuration.

*conceptual* · from the docs · also called Host Lockdown, BMC lockdown, LockdownHost, UnlockHost

- **Needs:** UEFI firmware and Secure Boot (ch. 5), UEFI/BIOS settings (ch. 8)
- **Docs:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Boot order and boot source override

The list of devices a server tries to boot from, plus a one-time or persistent override set through Redfish. NICo uses it to make hosts boot from the network.

*conceptual* · from the docs

- **Needs:** UEFI/BIOS settings (ch. 8), UEFI firmware and Secure Boot (ch. 5)
- **Docs:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

### cloud-init

A standard tool for configuring an OS on first boot from supplied user-data. NICo's PXE Service serves cloud-init user-data to hosts.

*conceptual* · from the docs · also called user-data, Cloud-init

- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### NTP time synchronization

A protocol for keeping clocks synchronized. NICo uses enterprise NTP servers to set BMC time before ingestion. It can also run a 3-replica chrony service (nico-ntp) whose addresses are handed to DPUs over DHCP.

*conceptual* · from the docs · also called Clock Synchronization

- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### DNS (authoritative and recursive)

An authoritative DNS server answers for zones it owns. A recursive resolver looks up any name for clients. NICo runs both: an authoritative server for its delegated zones, and unbound for managed machines.

*conceptual* · from the docs · also called DNS and DNS records, DNS, A record, AAAA record

- **Needs:** IP networking fundamentals (ch. 3)
- **Unlocks:** TLS certificates and X.509 SAN (ch. 19)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md)

### DHCP

The protocol devices use to get IP addresses automatically. A DHCP relay forwards requests from one network segment to a central server. NICo discovers BMCs when their relayed DHCP requests reach nico-dhcp.

*conceptual* · from the docs · also called DHCPv4, DHCPv6, DHCP and DHCP relay, DHCP relay

- **Needs:** CIDR prefixes and /31 point-to-point subnets (ch. 3)
- **Unlocks:** PXE / iPXE boot (ch. 12), Hardware discovery and ingestion (ch. 38), nico-dhcp and Kea hook (ch. 32), Out-of-band (OOB) management network (ch. 8), BMC Discovery (ch. 22), DPU mode vs NIC mode (ch. 12)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

### Out-of-band (OOB) management network

A separate management network that connects the BMCs. Its switches must relay BMC DHCP requests to the nico-dhcp VIP so that NICo can find the hosts.

*conceptual* · from the docs

- **Needs:** Baseboard Management Controller (BMC) (ch. 6), DHCP (ch. 8)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="chapter-9"></a>
## Chapter 9: Underlay & BGP

*Part: Networking & Isolation*

Builds on chapters 3, 7.

### Jumbo frames / MTU

The maximum packet size on a link. 9000-byte jumbo frames are used on the high-speed fabric.

*conceptual* · from the docs

- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### Underlay and overlay networks

The underlay is the physical routed network of switches. Overlays are virtual networks tunneled over it, such as tenant VPCs or the admin network.

*conceptual* · from the docs

- **Needs:** IP networking fundamentals (ch. 3)
- **Unlocks:** VXLAN and VNI (ch. 11), Underlay and HostInband network segments (ch. 12)
- **Docs:** [overview/scope-and-boundaries.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/scope-and-boundaries.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md)

### BGP

The routing protocol networks use to exchange routes. In NICo each DPU runs eBGP, often unnumbered (peering over link-local IPv6), with leaf switches or route servers to advertise its loopback and tenant routes.

*conceptual* · from the docs · also called BGP peering, ASN, BGPPeer, TOR switch

- **Needs:** CIDR prefixes and /31 point-to-point subnets (ch. 3)
- **Unlocks:** MetalLB LoadBalancer VIPs (ch. 15), VXLAN / EVPN (ch. 11), Autonomous System Number (ASN) (ch. 9), Top-of-rack (ToR) uplink (ch. 9), EVPN (ch. 11), Calico networking (ch. 15)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [overview/scope-and-boundaries.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/scope-and-boundaries.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [architecture/networking_integrations.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/networking_integrations.md)

### Autonomous System Number (ASN)

An identifier for a BGP routing domain. NICo gives every DPU a unique 32-bit ASN from a pool, following RFC 7938 data-center routing practice.

*conceptual* · from the docs

- **Needs:** BGP (ch. 9)
- **Docs:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md)

### Top-of-rack (ToR) uplink

The DPU's physical uplink ports (p0 and p1) to the rack switches. Normal PXE boot requires p0.

*conceptual* · from the docs

- **Needs:** BGP (ch. 9), BlueField DPU (ch. 7)
- **Unlocks:** BGP Peering with Top-of-Rack Switch (ch. 9)
- **Docs:** [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

### BGP Peering with Top-of-Rack Switch

The DPU's BGP session to the rack's switch on its uplink port (p0). A p0 transport failure blocks the PXE restart.

*conceptual* · from the docs

- **Needs:** Top-of-rack (ToR) uplink (ch. 9)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

<a id="chapter-10"></a>
## Chapter 10: DPU Networking · Addressing & Pools

*Part: Networking & Isolation*

Builds on chapters 1, 3, 6, 7.

### NVOS / NVUE

The NVIDIA switch and network operating system (NVOS) and its configuration and state API (NVUE). They are used on switches and in HBN on DPUs.

*conceptual* · from the docs

- **Unlocks:** Switch reachability monitor (ch. 49), Maintenance Activities (ch. 48)
- **Docs:** [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

### PF and VF (SR-IOV)

SR-IOV lets one NIC appear as a physical function (PF) plus several lightweight virtual functions (VFs). NICo gives each PF or VF its own tenant interface and /31.

*conceptual* · from the docs · also called UEFI boot order and BIOS settings, BIOS, UEFI, SR-IOV

- **Needs:** PCI device and slot address (ch. 1)
- **Unlocks:** PXE / iPXE boot (ch. 12), InstanceInfinibandConfig (ch. 44), Scalable Functions (SF) (ch. 10), Mellanox firmware tools (mlxconfig, mst) (ch. 11)
- **Docs:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [getting-started/installation-options/day0-credential-store.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-credential-store.md), [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md)

### Scalable Functions (SF)

Lightweight virtual network functions carved from a DPU's physical function. NICo reserves SFs for HBN service-VPC interfaces and for extra capacity.

*conceptual* · from the docs

- **Needs:** BlueField DPU (ch. 7), PF and VF (SR-IOV) (ch. 10)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### VLAN

A virtual LAN, which splits one physical Layer 2 network into isolated segments identified by a VLAN ID. NICo allocates VLAN IDs from a configured pool.

*conceptual* · from the docs

- **Needs:** Layer 2 Ethernet networking (ch. 3)
- **Unlocks:** VXLAN and VNI (ch. 11)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### IP address pools

Address ranges the site owner gives NICo for allocation: OOB management, DPU loopbacks, admin network, tenant networks (/31 per interface), and control-plane service VIPs.

*conceptual* · from the docs

- **Needs:** CIDR prefixes and /31 point-to-point subnets (ch. 3)
- **Docs:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md)

### BMC network IP addressing

Planning the address ranges for BMCs. Every endpoint needs one IP, and a 1,112-rack site needs 78,952 addresses, more than one /16 subnet (65,536) holds.

*conceptual* · from the docs

- **Needs:** Baseboard Management Controller (BMC) (ch. 6), CIDR prefixes and /31 point-to-point subnets (ch. 3)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

<a id="chapter-11"></a>
## Chapter 11: VXLAN/EVPN Overlay

*Part: Networking & Isolation*

Builds on chapters 3, 9, 10.

### Mellanox firmware tools (mlxconfig, mst)

Command-line tools for inspecting and configuring ConnectX NIC firmware settings, such as link type and the number of VFs. They operate per physical card.

*procedural* · from the docs · also called MLX Configuration

- **Needs:** PF and VF (SR-IOV) (ch. 10)
- **Unlocks:** NIC Firmware Execution Phases (ch. 43)
- **Docs:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### VRF

A separate routing table on one device, which keeps each tenant's routes isolated from the others.

*conceptual* · from the docs · also called Virtual Routing and Forwarding

- **Needs:** IP networking fundamentals (ch. 3)
- **Unlocks:** VNI (L2VNI / L3VNI) (ch. 11), Route targets (import/export) (ch. 11), VPC (FNN VPC) (ch. 29)
- **Docs:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### VXLAN and VNI

VXLAN carries layer-2 overlay networks over a routed fabric. Each overlay is identified by a VNI, and VTEPs are the endpoints of the tunnels.

*conceptual* · from the docs · also called VXLAN, VNI, VXLAN Network Identifier, VTEP

- **Needs:** VLAN (ch. 10), Underlay and overlay networks (ch. 9)
- **Unlocks:** NICo resource pools (ch. 12), VXLAN / EVPN (ch. 11), EVPN (ch. 11), Multi-tenancy (ch. 23)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### VXLAN / EVPN

VXLAN wraps Layer-2/3 traffic in UDP so overlay networks can run over a routed underlay. EVPN is the BGP address family that spreads overlay reachability. DPUs act as the VXLAN tunnel endpoints (VTEPs).

*conceptual* · from the docs · also called VTEP, VXLAN Tunnel Endpoint

- **Needs:** BGP (ch. 9), VXLAN and VNI (ch. 11)
- **Unlocks:** Host-Based Networking (HBN) (ch. 29), VNI (L2VNI / L3VNI) (ch. 11), Route targets (import/export) (ch. 11)
- **Docs:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### EVPN

A BGP-based control plane that tells VTEPs which tenant addresses are reachable where in a VXLAN overlay.

*conceptual* · from the docs

- **Needs:** BGP (ch. 9), VXLAN and VNI (ch. 11)
- **Unlocks:** Host-Based Networking (HBN) (ch. 29)
- **Docs:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### VNI (L2VNI / L3VNI)

The ID that tells VXLAN overlay segments apart. Each VPC needs a unique L3VNI for its VRF, and the admin network uses one L2VNI. VNIs must be unique across the datacenter.

*conceptual* · from the docs · also called VNI, VXLAN Network Identifier

- **Needs:** VXLAN / EVPN (ch. 11), VRF (ch. 11)
- **Docs:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### Route targets (import/export)

BGP EVPN tags attached to routes that decide which VRFs import them. NICo uses conventional values (:50100 to :50500) so tenant/admin networks and control-plane VIPs can reach each other.

*conceptual* · from the docs

- **Needs:** VXLAN / EVPN (ch. 11), VRF (ch. 11)
- **Docs:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md)

<a id="chapter-12"></a>
## Chapter 12: Boot & Network Services

*Part: Networking & Isolation*

Builds on chapters 3, 5, 7, 8, 9, 10, 11.

### PXE / iPXE boot

Booting a machine over the network, where firmware fetches boot scripts and OS images from a server. NICo's PXE Service delivers iPXE scripts, cloud-init data and images over HTTP.

*conceptual* · from the docs · also called PXE / iPXE Boot, PXE, iPXE, custom iPXE

- **Needs:** DHCP (ch. 8), UEFI firmware and Secure Boot (ch. 5), PF and VF (SR-IOV) (ch. 10)
- **Unlocks:** Boot artifacts (ch. 13), iPXE-based DPU provisioning (ch. 27)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [overview/scope-and-boundaries.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/scope-and-boundaries.md), [overview/operational-principles.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/operational-principles.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### NICo resource pools

Ranges that NICo allocates from. They cover loopback IPs for hosts and DPUs, VLAN IDs and VXLAN VNIs. All three must be non-empty.

*conceptual* · from the docs

- **Needs:** VXLAN and VNI (ch. 11), CIDR prefixes and /31 point-to-point subnets (ch. 3)
- **Unlocks:** VNI resource pool (ch. 12)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

### Underlay and HostInband network segments

NICo's physical network segment types. Underlay carries BMC and DPU out-of-band interfaces. HostInband is shared by zero-DPU host OS interfaces and, optionally, their BMCs.

*conceptual* · from the docs

- **Needs:** Underlay and overlay networks (ch. 9), Out-of-band (OOB) management (ch. 7), BlueField DPU (ch. 7)
- **Unlocks:** HostInband Network Segment (ch. 29)
- **Docs:** [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md)

### VNI resource pool

Operator-configured ranges of VNIs that NICo hands out to VPCs. The size of the pool bounds how many VPCs a site can have, and an established pool can be extended with nico-admin-cli.

*conceptual* · from the docs

- **Needs:** NICo resource pools (ch. 12)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

### DPU mode vs NIC mode

A BlueField can run in DPU mode, where its ARM OS manages networking, or in NIC mode, where it acts as a plain NIC. Hosts in NIC mode and hosts without a DPU (zero-DPU hosts) use central DHCP on HostInband instead of a local DHCP server on the DPU.

*conceptual* · from the docs · also called NIC mode, DPU-NIC-mode, Zero-DPU Host, BlueField Operating Mode

- **Needs:** BlueField DPU (ch. 7), DHCP (ch. 8)
- **Unlocks:** DPU-host pairing (ch. 22), HostInband Network Segment (ch. 29), Mellanox Device Kind (ch. 23)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md), [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md)

<a id="chapter-13"></a>
## Chapter 13: Building Images

*Part: Kubernetes & Deployment*

Builds on chapters 1, 2, 7, 12.

### Rust toolchain and Cargo

Rust's compiler and package/build tool. NICo is written in Rust, and its build tasks are driven with cargo-make.

*conceptual* · from the docs

- **Unlocks:** Build host bootstrap (make bootstrap) (ch. 13)
- **Docs:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

### Build host bootstrap (make bootstrap)

A single, repeatable step on Ubuntu 24.04 that installs the packages, rustup, git submodules, Docker with emulation, and cargo tooling needed for the full image and boot-artifact builds.

*procedural* · from the docs

- **Needs:** Rust toolchain and Cargo (ch. 13)
- **Unlocks:** Building all images (make images) (ch. 13), Building local dev images (make images-dev) (ch. 13)
- **Docs:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

### Container registry

A server that stores and serves container images. The Makefile pushes to a local registry on localhost:5000 unless you override IMAGE_REGISTRY.

*conceptual* · from the docs · also called Container image registry, Container image registry (NGC/nvcr.io), NGC, nvcr.io

- **Needs:** Containers and container images (ch. 2)
- **Unlocks:** Multi-architecture image manifest (ch. 13), containerd (ch. 27)
- **Docs:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### Docker BuildKit and Buildx

BuildKit is Docker's image build engine and Buildx is its CLI front end. NICo's build recipes pin both the Docker context and the builder so that every build runs on one daemon.

*conceptual* · from the docs

- **Needs:** Containers and container images (ch. 2)
- **Unlocks:** Building all images (make images) (ch. 13), Building local dev images (make images-dev) (ch. 13), Cross-architecture emulation (binfmt/QEMU) (ch. 13)
- **Docs:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

### Building local dev images (make images-dev)

Builds one native Core development service image, such as api or dhcp, using the same recipes as Tilt, in a Linux Docker daemon. It does not push or deploy the image.

*procedural* · from the docs

- **Needs:** Docker BuildKit and Buildx (ch. 13), Build host bootstrap (make bootstrap) (ch. 13)
- **Docs:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

### Cross-architecture emulation (binfmt/QEMU)

Linux binfmt_misc registration with QEMU, which lets a host build and run images for a different CPU architecture. The -arm build targets avoid it by building natively.

*conceptual* · from the docs

- **Needs:** Docker BuildKit and Buildx (ch. 13), CPU architectures (amd64 vs arm64) (ch. 1)
- **Docs:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

### Multi-architecture image manifest

A single image tag that points to separate images for each CPU architecture. NICo builds amd64 and arm64 separately and then assembles the combined tag.

*conceptual* · from the docs

- **Needs:** Container registry (ch. 13)
- **Unlocks:** Building all images (make images) (ch. 13)
- **Docs:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

### Building all images (make images)

Make targets that build and push the deployable stack (NICo Core and the REST images), and optionally the machine-validation and boot-artifact images, for chosen architectures. A loop afterwards checks each tag's platforms.

*procedural* · from the docs · also called Building NICo containers

- **Needs:** Multi-architecture image manifest (ch. 13), Build host bootstrap (make bootstrap) (ch. 13), Docker BuildKit and Buildx (ch. 13)
- **Docs:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

### Boot artifacts

The OS images and binaries that NICo serves to network-boot hosts and DPUs. They are built with mkosi and iPXE and packaged into containers.

*conceptual* · from the docs

- **Needs:** PXE / iPXE boot (ch. 12)
- **Unlocks:** DPU BFB (ch. 13)
- **Docs:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

### DPU BFB

The BlueField Bootstream image format used to install software on a DPU. NICo builds it as the aarch64 boot artifact.

*conceptual* · from the docs · also called BFB (BlueField Bundle), BFB, bf-bundle, bfb_url

- **Needs:** BlueField DPU (ch. 7), Boot artifacts (ch. 13)
- **Unlocks:** bf.cfg parameters (ch. 28), DPU reprovisioning (ch. 27), Preingestion Manager (ch. 38)
- **Docs:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="chapter-14"></a>
## Chapter 14: Kubernetes Basics

*Part: Kubernetes & Deployment*

Builds on chapters 2, 3.

### Virtual IP address (VIP)

A stable IP address assigned to a service rather than to one machine. Each NICo Core LoadBalancer service needs a fixed VIP from the MetalLB pool so that DHCP relays, DNS and PXE can be configured in advance.

*conceptual* · from the docs · also called Virtual IP with keepalived/VRRP, VIP, keepalived, VRRP

- **Needs:** IP addressing basics (ch. 3)
- **Unlocks:** DPUCluster (ch. 37), Layer 2 advertisement (ARP) (ch. 15)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### Kubernetes

A container orchestration platform. NICo's control plane is deployed on it as microservices and needs v1.30 or later.

*conceptual* · from the docs · also called K8s, host cluster, StatefulSet, ConfigMap

- **Needs:** Containers and container images (ch. 2)
- **Unlocks:** Site Controller (ch. 18), CNI (ch. 15), Kubernetes workload and config objects (ch. 14), Kamaji (ch. 27), HashiCorp Vault (ch. 20), Tilt (ch. 15), Node Feature Discovery (NFD) (ch. 27)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### Kubernetes workload and config objects

The basic Kubernetes resources the docs refer to constantly. Pods run containers. StatefulSets run replicated stateful apps. Secrets and ConfigMaps hold credentials and configuration. Jobs run one-off tasks. Services expose pods on the network.

*conceptual* · from the docs

- **Needs:** Kubernetes (ch. 14)
- **Unlocks:** Kustomize (ch. 17), Kubernetes Service types (LoadBalancer, NodePort, ClusterIP) (ch. 14), Kubernetes Custom Resource (CR/CRD) (ch. 14), Kubernetes resource limits (ch. 16), Pod anti-affinity (ch. 16), Persistent storage (StorageClass, PVC, local-path-provisioner) (ch. 14), Helm and helmfile (ch. 17), Kubernetes Secret (ch. 14), Kubernetes RBAC (ch. 14)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

### Kubernetes Custom Resource (CR/CRD)

A user-defined Kubernetes API object type. Operators reconcile these objects into real state. DPF exposes CRs such as DPUDeployment, DPUFlavor and BFB.

*conceptual* · from the docs · also called Kubernetes Operator / CRDs, Kubernetes operator

- **Needs:** Kubernetes workload and config objects (ch. 14)
- **Unlocks:** cert-manager (ch. 19), External Secrets Operator (ESO) (ch. 21), PostgreSQL (Zalando operator) (ch. 17), DOCA Platform Framework (DPF) (ch. 36)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md)

### Kubernetes Service types (LoadBalancer, NodePort, ClusterIP)

The ways a Kubernetes Service can be exposed. ClusterIP is reachable only inside the cluster. NodePort opens a port on every node. LoadBalancer gets an external IP, which MetalLB supplies on bare metal.

*conceptual* · from the docs

- **Needs:** Kubernetes workload and config objects (ch. 14)
- **Unlocks:** MetalLB LoadBalancer VIPs (ch. 15), Kubernetes Ingress and ingress controllers (ch. 22), Kubernetes Service externalIP (ch. 16), Selectorless Service with manual Endpoints (ch. 27)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

### Persistent storage (StorageClass, PVC, local-path-provisioner)

The Kubernetes system for durable volumes. local-path-provisioner creates StorageClasses backed by node-local disks, and the PostgreSQL and Vault volume claims use them.

*conceptual* · from the docs

- **Needs:** Kubernetes workload and config objects (ch. 14)
- **Unlocks:** PostgreSQL (Zalando operator) (ch. 17)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md)

### Kubernetes RBAC

Kubernetes' role-based access control. Roles list the allowed verbs on resources, and bindings grant those roles to identities such as ServiceAccounts.

*conceptual* · from the docs

- **Needs:** Kubernetes workload and config objects (ch. 14)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### Kubernetes Secret

A Kubernetes object that holds sensitive data such as passwords or registry credentials. Pods can reference it, for example to pull private images.

*conceptual* · from the docs · also called Kubernetes secrets, K8S secrets

- **Needs:** Kubernetes workload and config objects (ch. 14)
- **Unlocks:** GitOps with ArgoCD (ch. 17), Site-wide BMC root credential (ch. 20), External Secrets Operator (ESO) (ch. 21), DPU agent bootstrap CA (ch. 38)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md), [architecture/networking_integrations.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/networking_integrations.md)

<a id="chapter-15"></a>
## Chapter 15: Cluster Networking

*Part: Kubernetes & Deployment*

Builds on chapters 3, 9, 14.

### Tilt

A local Kubernetes development tool that builds and deploys services when code changes. NICo's dev image recipes are shared with it.

*conceptual* · from the docs

- **Needs:** Kubernetes (ch. 14)
- **Docs:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

### CNI

The Kubernetes plugin layer that provides pod networking. Calico is validated for NICo. Tenant clusters need a CNI that works over routed (not L2) node connectivity.

*conceptual* · from the docs

- **Needs:** Kubernetes (ch. 14), IP networking fundamentals (ch. 3)
- **Unlocks:** Calico networking (ch. 15)
- **Docs:** [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [overview/scope-and-boundaries.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/scope-and-boundaries.md)

### MetalLB LoadBalancer VIPs

MetalLB gives bare-metal Kubernetes LoadBalancer services virtual IPs and advertises them over BGP or L2. This makes NICo pods reachable from BMCs, the admin network and tenant VPCs.

*conceptual* · from the docs · also called MetalLB, metallb, IPAddressPool, BGPAdvertisement

- **Needs:** BGP (ch. 9), Kubernetes Service types (LoadBalancer, NodePort, ClusterIP) (ch. 14)
- **Unlocks:** Layer 2 advertisement (ARP) (ch. 15)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md), [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

### Calico networking

A Kubernetes network plugin. Its calico-node pod runs the BIRD BGP daemon, whose health probes needed longer timeouts once nodes carried very many addresses.

*conceptual* · from the docs

- **Needs:** CNI (ch. 15), BGP (ch. 9)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

### Layer 2 advertisement (ARP)

A MetalLB mode for flat networks without BGP. A node answers ARP requests for the VIP on the local network segment.

*conceptual* · from the docs

- **Needs:** MetalLB LoadBalancer VIPs (ch. 15), Virtual IP address (VIP) (ch. 14)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="chapter-16"></a>
## Chapter 16: Scale & Sizing

*Part: Kubernetes & Deployment*

Builds on chapters 2, 6, 14.

### Kubernetes resource limits

Per-container caps on CPU and memory set in the pod spec or Helm values. Kubernetes reports CPU in logical CPUs (hyper-threads).

*conceptual* · from the docs

- **Needs:** Kubernetes workload and config objects (ch. 14)
- **Unlocks:** Tokio worker threads (ch. 16), Kubelet working set and OOM kill (ch. 16)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

### Pod anti-affinity

A Kubernetes scheduling rule that keeps certain pods off the same node. The 20k-host runs used it to put nico-api and the Postgres primary on different nodes.

*conceptual* · from the docs

- **Needs:** Kubernetes workload and config objects (ch. 14)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

### Kubelet working set and OOM kill

The working set is resident memory plus active page cache. It naturally grows toward the memory limit, so the real sign that more memory is needed is a rising oom_kill count in the container's cgroup.

*conceptual* · from the docs

- **Needs:** Kubernetes resource limits (ch. 16), Linux memory and cgroups (ch. 2)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

### Kubernetes Service externalIP

A Kubernetes Service field that exposes a Service on a specific IP address. The simulator publishes each simulated BMC address this way.

*conceptual* · from the docs

- **Needs:** Kubernetes Service types (LoadBalancer, NodePort, ClusterIP) (ch. 14)
- **Unlocks:** Machine-a-tron (ch. 16), kube-proxy IPVS mode (ch. 16)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

### Tokio worker threads

The threads that run the async Rust Tokio runtime inside nico-api. Raise their count to match nico-api's CPU limit so the extra CPU actually gets used.

*conceptual* · from the docs

- **Needs:** Kubernetes resource limits (ch. 16), Asynchronous programming (async/await) (ch. 2)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

### kube-proxy IPVS mode

A kube-proxy mode that routes Service traffic with Linux IP Virtual Server. Each node keeps one ipset of addresses that holds at most 65,536 entries, which caps a stock simulator at about 736 racks.

*conceptual* · from the docs

- **Needs:** Kubernetes Service externalIP (ch. 16)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

### Machine-a-tron

NICo's fleet simulator. It runs simulated BMCs and agents in Kubernetes pods behind a protocol gateway so the control plane can be scale-tested without real hardware.

*conceptual* · from the docs

- **Needs:** Baseboard Management Controller (BMC) (ch. 6), Kubernetes Service externalIP (ch. 16)
- **Unlocks:** Fleet-up and time to ready (ch. 42)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

<a id="chapter-17"></a>
## Chapter 17: Helm & GitOps · Installation & Setup

*Part: Kubernetes & Deployment*

Builds on chapters 1, 2, 4, 14.

### Helm and helmfile

Helm is the Kubernetes package manager. It installs charts configured through YAML values files. helmfile declaratively manages several Helm releases and uses the helm-diff plugin to show what will change.

*procedural* · from the docs · also called Helm chart, Helm, values.yaml, helm repo

- **Needs:** Kubernetes workload and config objects (ch. 14), YAML (ch. 1)
- **Unlocks:** setup.sh orchestrator (ch. 17), GitOps with ArgoCD (ch. 17), DPU Agent (ch. 38), Helm chart values (ch. 17)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### Kustomize

A Kubernetes tool that customizes manifests by layering overlays on top of base manifests. setup.sh can apply a site overlay with it, and the REST stack uses kustomize bases.

*procedural* · from the docs

- **Needs:** Kubernetes workload and config objects (ch. 14)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md)

### GitOps with ArgoCD

Continuous delivery where a controller syncs cluster state from Git. It is an optional way to deploy and update NICo.

*conceptual* · from the docs · also called Argo CD

- **Needs:** Helm and helmfile (ch. 17), Kubernetes Secret (ch. 14), Git version control (ch. 2)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### Helm chart values

Configuration files that customize a Helm deployment. NICo ships sizing values, for example for 10k and 20k hosts, through them.

*procedural* · from the docs

- **Needs:** Helm and helmfile (ch. 17)
- **Unlocks:** Rack profile (ch. 29), IPv6 metadata transport (ch. 41)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

### PostgreSQL (Zalando operator)

The relational database holding all NICo state. Only the API Service reads and writes it. The reference deployment uses the Zalando Postgres Operator and needs the btree_gin and pg_trgm extensions.

*conceptual* · from the docs · also called Postgres primary, PostgreSQL, max_database_connections, Postgres

- **Needs:** Kubernetes Custom Resource (CR/CRD) (ch. 14), Persistent storage (StorageClass, PVC, local-path-provisioner) (ch. 14), Relational databases and SQL (ch. 1)
- **Unlocks:** API Service (NICo Core) (ch. 31), Controller State Persistence (ch. 30)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [architecture/flow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/flow.md)

### setup.sh orchestrator

The script in helm-prereqs/ that installs every prerequisite and NICo component in numbered phases (0 to 7i). Flags such as --skip-vault, --skip-dpf and -y control it. It is idempotent, so you upgrade by re-running it.

*procedural* · from the docs · also called setup.sh automated install

- **Needs:** Helm and helmfile (ch. 17), Idempotency (ch. 4)
- **Unlocks:** Preflight checks (preflight.sh) (ch. 17), Site and site UUID registration (ch. 33)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### Preflight checks (preflight.sh)

A validation script that runs at the start of setup.sh. It checks environment variables, required tools, MetalLB config, cluster reachability, node count, kernel parameters, DNS, registry connectivity and Vault-free values. Errors stop the setup.

*procedural* · from the docs

- **Needs:** setup.sh orchestrator (ch. 17)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="chapter-18"></a>
## Chapter 18: Cryptography

*Part: Security & Identity*

Builds on chapters 4, 14.

### Site Controller

The NICo control plane: a suite of microservices running on a Kubernetes cluster of at least three nodes, located in the datacenter it manages.

*conceptual* · from the docs · also called NICo site controller, site controller, NICo Core, NICo site

- **Needs:** Kubernetes (ch. 14), Microservices architecture (ch. 4)
- **Unlocks:** API Service (NICo Core) (ch. 31)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md), [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [architecture/key_group_sync.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/key_group_sync.md), [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md)

### AES-GCM symmetric encryption

An authenticated symmetric cipher that uses a shared secret key (here 256-bit) to provide both confidentiality and integrity. Additional authenticated data (AAD) binds extra context into the ciphertext.

*conceptual* · from the docs

- **Unlocks:** Envelope encryption and KEK (ch. 18)
- **Docs:** [architecture/flow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/flow.md), [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md), [getting-started/installation-options/day0-credential-store.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-credential-store.md)

### Key Derivation Function (KDF)

A function that deterministically produces cryptographic keys from secret input material plus context. The same inputs always give the same key, and different contexts give independent keys.

*conceptual* · from the docs

- **Unlocks:** KDF Context (ch. 42), Entropy and Offline Guessing (ch. 19)
- **Docs:** [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md)

### Cryptographic hashing

One-way functions that produce a fixed-size digest of data.

*conceptual* · background, 1 level below the docs

- **Unlocks:** Public-key cryptography (ch. 18)

### Envelope encryption and KEK

Data is encrypted with data keys, and those keys are in turn encrypted (wrapped) with a master key encryption key (KEK). You keep the KEK safe and track its key ID so you can rotate it.

*conceptual* · from the docs

- **Needs:** AES-GCM symmetric encryption (ch. 18)
- **Unlocks:** Machine identity (JWT-SVID issuance) (ch. 43), Credential store (Vault vs Postgres) (ch. 34), KMIP KEK provider (ch. 21)
- **Docs:** [getting-started/installation-options/day0-credential-store.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-credential-store.md), [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md)

### Public-key cryptography

Cryptography that uses a public/private key pair for encryption and digital signatures.

*conceptual* · background, 1 level below the docs

- **Needs:** Cryptographic hashing (ch. 18)
- **Unlocks:** PKI and TLS certificates (ch. 19), OIDC / JWT authentication (Keycloak) (ch. 19), SSH (ch. 22)

<a id="chapter-19"></a>
## Chapter 19: PKI & Certificates · Authentication & Identity

*Part: Security & Identity*

Builds on chapters 1, 3, 8, 14, 18.

### Entropy and Offline Guessing

A secret's strength comes from how unpredictable it is. HKDF adds no entropy, so if a card key leaks, a weak IKM could be guessed offline.

*conceptual* · from the docs

- **Needs:** Key Derivation Function (KDF) (ch. 18)
- **Unlocks:** Input Key Material (IKM) (ch. 35)
- **Docs:** [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md)

### OIDC / JWT authentication (Keycloak)

OIDC is a standard for logging in through an identity provider such as Keycloak, which issues signed JWT tokens. NICo REST accepts JWTs, and the admin web UI uses OIDC.

*conceptual* · from the docs · also called Keycloak, keycloak, nico realm, realm

- **Needs:** HTTP and web APIs (ch. 3), Public-key cryptography (ch. 18)
- **Unlocks:** NICo REST (JSON API) (ch. 31), OAuth2 client credentials flow and JWT bearer tokens (ch. 19), SPIFFE (ch. 21)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md), [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md)

### OAuth2 client credentials flow and JWT bearer tokens

A machine-to-machine flow in which a client exchanges its ID and secret for a signed JWT access token, then sends it in an Authorization: Bearer header. The token's iss claim must match what the API expects.

*procedural* · from the docs

- **Needs:** OIDC / JWT authentication (Keycloak) (ch. 19)
- **Unlocks:** Org bootstrap (InfrastructureProvider, Tenant, TenantAccount) (ch. 33), nicocli (ch. 31), Token delegation (RFC 8693 token exchange) (ch. 19)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

### Token delegation (RFC 8693 token exchange)

An OAuth standard for exchanging one token for another at a security token service (STS). NICo can use it to delegate tokens to external STS endpoints, optionally through an egress proxy.

*conceptual* · from the docs

- **Needs:** OAuth2 client credentials flow and JWT bearer tokens (ch. 19)
- **Docs:** [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md)

### PKI and TLS certificates

Public key infrastructure: a certificate authority signs certificates that bind identities (DNS names in the SANs) to keys. Services use these certificates for TLS and mTLS.

*conceptual* · from the docs · also called Public key infrastructure and CA trust

- **Needs:** Public-key cryptography (ch. 18)
- **Unlocks:** HashiCorp Vault (ch. 20), TPM and Measured Boot attestation (ch. 20), TLS certificates and X.509 SAN (ch. 19), SPIFFE (ch. 21), SPDM attestation (ch. 20)
- **Docs:** [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md)

### TLS certificates and X.509 SAN

Certificates that prove a server's identity and enable encrypted connections. Subject Alternative Names list the hostnames a certificate covers, and a wildcard covers exactly one DNS label.

*conceptual* · from the docs · also called TLS certificate

- **Needs:** PKI and TLS certificates (ch. 19), DNS (authoritative and recursive) (ch. 8)
- **Unlocks:** mTLS / gRPC (ch. 19)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [architecture/state_machines/switch_configure_certificate.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch_configure_certificate.md), [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md)

### mTLS / gRPC

gRPC is a binary RPC protocol. Mutual TLS means both client and server present certificates to prove their identity. All NICo control-plane services talk to each other using gRPC over mTLS.

*conceptual* · from the docs · also called Mutual TLS (mTLS), mTLS, client certificates, gRPC

- **Needs:** TLS certificates and X.509 SAN (ch. 19), Protocol Buffers (ch. 1)
- **Unlocks:** API Service (NICo Core) (ch. 31), KMIP KEK provider (ch. 21), cert-manager (ch. 19), Rack Management Service (RMS) (ch. 29), NVLink partitioning with NMX-C (ch. 30), Client identity (ch. 21), State Controller Tick (ch. 31)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md)

### cert-manager

A Kubernetes controller that issues and rotates TLS certificates from configured issuers, such as the site-root CA or Vault PKI. NICo uses it for its mTLS certificates.

*conceptual* · from the docs · also called cert-manager and Issuers, ClusterIssuer, Issuer, Certificate resource

- **Needs:** Kubernetes Custom Resource (CR/CRD) (ch. 14), mTLS / gRPC (ch. 19)
- **Unlocks:** Kubernetes Ingress and ingress controllers (ch. 22), cert-manager approver-policy (ch. 27), Credential store (Vault vs Postgres) (ch. 34)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

<a id="chapter-20"></a>
## Chapter 20: Credentials & Secrets · Security & Identity

*Part: Security & Identity*

Builds on chapters 5, 6, 14, 19.

### HashiCorp Vault

A secrets manager whose PKI engine issues certificates and whose KV engine stores credentials. NICo services authenticate to it with Kubernetes auth. It is optional: the --skip-vault install keeps credentials in Postgres instead.

*conceptual* · from the docs · also called Vault, HA Raft, Vault unseal, --skip-vault

- **Needs:** PKI and TLS certificates (ch. 19), Kubernetes (ch. 14)
- **Unlocks:** Credential store (Vault vs Postgres) (ch. 34), External Secrets Operator (ESO) (ch. 21)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### Site-wide BMC root credential

The shared BMC password that NICo applies to managed hardware. carbide-api copies its current version into the bmc-shared-password Secret every 60 seconds so DPF can reach BMCs. DPU registration is blocked until this credential is set.

*conceptual* · from the docs · also called BMC Site-Wide Root Credential

- **Needs:** Baseboard Management Controller (BMC) (ch. 6), Kubernetes Secret (ch. 14)
- **Unlocks:** Credential source modes (local / local_first / backend) (ch. 34), BMC credential rotation (ch. 20), Hardware discovery and ingestion (ch. 38)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md), [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md)

### Factory default credentials

The vendor default BMC and UEFI passwords that NICo needs to log into new hardware for the first time. They can be seeded into Vault, imported, or added through the CLI.

*procedural* · from the docs

- **Needs:** Baseboard Management Controller (BMC) (ch. 6), UEFI firmware and Secure Boot (ch. 5)
- **Unlocks:** Expected Machines Manifest (ch. 22), Site-wide BMC and UEFI credentials (ch. 34)
- **Docs:** [getting-started/installation-options/day0-credential-store.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-credential-store.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md)

### BMC credential rotation

Moving managed BMCs to a new versioned password. DPF v26.4.0 does not support this, so rotation must not be staged while DPF manages any DPU.

*conceptual* · from the docs · also called Account Service, password policy

- **Needs:** Site-wide BMC root credential (ch. 20), Redfish API (ch. 6)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

### TPM and Measured Boot attestation

A TPM chip records hashes of boot components in Platform Configuration Registers (PCRs). Attestation checks these measurements and the TPM's signature, using the TPM Manufacturer CA, to prove a host booted untampered. In NICo it is off by default.

*conceptual* · from the docs · also called Measured Boot with TPM 2.0, TPM, Trusted Platform Module, TrustedModules

- **Needs:** UEFI firmware and Secure Boot (ch. 5), PKI and TLS certificates (ch. 19)
- **Unlocks:** Hardware discovery and ingestion (ch. 38)
- **Docs:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

### SPDM attestation

A protocol for checking a hardware component's identity and firmware measurements using certificates and signed measurements. NICo triggers evidence collection through Redfish ComponentIntegrity and has its own controller for it.

*conceptual* · from the docs

- **Needs:** PKI and TLS certificates (ch. 19), Redfish API (ch. 6)
- **Docs:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [architecture/state_handling.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_handling.md)

<a id="chapter-21"></a>
## Chapter 21: Authentication & Identity

*Part: Security & Identity*

Builds on chapters 14, 18, 19, 20.

### SPIFFE

A standard for workload identity. Workloads get a SPIFFE ID within a trust domain and prove it with an SVID, which is either an X.509 certificate or a JWT.

*conceptual* · from the docs · also called SPIFFE Identity, JWT-SVID, IMDS, FMDS

- **Needs:** PKI and TLS certificates (ch. 19), OIDC / JWT authentication (Keycloak) (ch. 19)
- **Unlocks:** Machine identity (JWT-SVID issuance) (ch. 43)
- **Docs:** [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md), [architecture/backends/rms.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/backends/rms.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### Client identity

The identity, typically from the client's certificate, that nico-api uses to apply per-client limits. On real hardware each host and DPU agent has its own identity.

*conceptual* · from the docs

- **Needs:** mTLS / gRPC (ch. 19)
- **Unlocks:** API admission control (ch. 32), Role-Based Access Control (RBAC) (ch. 21)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

### Role-Based Access Control (RBAC)

Granting permissions to roles instead of individual users. For example, Core grants OnDemandRackMaintenance to the NicoAdminCLI role, and REST uses provider/tenant admin and viewer roles.

*conceptual* · from the docs

- **Needs:** Client identity (ch. 21)
- **Docs:** [architecture/state_machines/rack.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rack.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### External Secrets Operator (ESO)

A Kubernetes operator that copies secrets from a backing store into Kubernetes Secret objects. In NICo it copies CA bundles and DB credentials into NICo namespaces.

*conceptual* · from the docs · also called External Secrets Operator, external-secrets, ClusterSecretStore

- **Needs:** Kubernetes Custom Resource (CR/CRD) (ch. 14), HashiCorp Vault (ch. 20), Kubernetes Secret (ch. 14)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md)

### KMIP KEK provider

An opt-in feature that gets the key-encryption keys protecting stored secrets from an external KMIP key-management server. The connection uses client TLS files (ca.pem, client.pem, client.key).

*conceptual* · from the docs · also called Key Encryption Key (KEK), KEK

- **Needs:** mTLS / gRPC (ch. 19), Envelope encryption and KEK (ch. 18)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md)

<a id="chapter-22"></a>
## Chapter 22: Discovery & Ingestion

*Part: Host Lifecycle*

Builds on chapters 1, 3, 6, 8, 12, 14, 18, 19, 20.

### SSH

A protocol for secure remote shell access.

*procedural* · background, 1 level below the docs

- **Needs:** Public-key cryptography (ch. 18)
- **Unlocks:** Serial-over-LAN and SSH Console Service (ch. 26)

### Kubernetes Ingress and ingress controllers

An Ingress routes external HTTP(S) traffic to Services by hostname, and an ingress controller such as Contour/Envoy or nginx handles it. You can use one to expose nico-rest-api on a domain name with TLS instead of a NodePort.

*procedural* · from the docs

- **Needs:** Kubernetes Service types (LoadBalancer, NodePort, ClusterIP) (ch. 14), cert-manager (ch. 19)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md)

### PN/PSID

The part number and Parameter-Set ID that identify an NVIDIA NIC model and its firmware configuration. They are used to match cards to the allow-list.

*conceptual* · from the docs

- **Unlocks:** NIC Firmware Baseline Policy (ch. 36), Mellanox Device Kind (ch. 23)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Secure Erase

A drive-level command that cryptographically or physically wipes all data on NVMe/SAS/SATA drives. NICo requires drives that support it.

*conceptual* · from the docs

- **Needs:** Server hardware basics (ch. 1)
- **Unlocks:** Tenant sanitization (ch. 40)
- **Docs:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md)

### LLDP

A layer-2 protocol where devices advertise their identity to directly connected neighbors. NICo uses it to work out which DPU belongs to which host.

*conceptual* · from the docs · also called lldpcli, LLDP-MED, nico-lldp-sidecar, Link Layer Discovery Protocol

- **Needs:** IP networking fundamentals (ch. 3)
- **Unlocks:** Hardware discovery and ingestion (ch. 38)
- **Docs:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### Expected Machines Manifest

A JSON file listing each host's BMC MAC address, chassis serial number and factory BMC credentials. Only hosts in this file are discovered and ingested.

*procedural* · from the docs · also called Expected machines manifest, expected_machines.json, em replace-all, Expected Machines manifest

- **Needs:** MAC address (ch. 1), Factory default credentials (ch. 20)
- **Unlocks:** Hardware discovery and ingestion (ch. 38), Switch State Machine (ch. 47), BMC Discovery (ch. 22)
- **Docs:** [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### DPU-host pairing

Site Explorer works out which DPU belongs to which host by matching the serial numbers reported by host and DPU BMCs, then checks DPU mode and completeness.

*procedural* · from the docs · also called pairing

- **Needs:** DPU mode vs NIC mode (ch. 12), PCIe device (ch. 1), MAC address (ch. 1), Redfish resource tree (Systems, Chassis, Managers) (ch. 6)
- **Docs:** [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

### BMC Discovery

How NICo finds BMCs. A BMC requests an IP address over DHCP (relayed to NICo), and NICo matches its MAC address against the expected-machines table to look up its initial credentials.

*procedural* · from the docs

- **Needs:** DHCP (ch. 8), Expected Machines Manifest (ch. 22)
- **Docs:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="chapter-23"></a>
## Chapter 23: NICo Architecture · BlueField DPU

*Part: NICo Architecture*

Builds on chapters 5, 7, 11, 12, 22.

### Multi-tenancy

Several customers (tenants) share the same physical infrastructure, and each must be isolated from the others.

*conceptual* · from the docs · also called Tenant, Tenant Org, Multi-Tenancy and Isolation

- **Needs:** VXLAN and VNI (ch. 11)
- **Unlocks:** Zero-trust host model (ch. 23), Network planes (Ethernet, InfiniBand, NVLink) (ch. 24), Static network fabric principle (ch. 24), VPC (FNN VPC) (ch. 29)
- **Docs:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [overview/scope-and-boundaries.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/scope-and-boundaries.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md), [architecture/key_group_sync.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/key_group_sync.md)

### Zero-trust host model

NICo's principle that software inside the host OS is never trusted for security or isolation decisions. Enforcement happens on the DPU, and monitoring happens out-of-band.

*conceptual* · from the docs

- **Needs:** Out-of-band (OOB) management (ch. 7), BlueField DPU (ch. 7), Multi-tenancy (ch. 23)
- **Unlocks:** NICo (NVIDIA Infra Controller) (ch. 23), DPU restricted mode (ch. 23), SuperNIC Lockdown (ch. 25)
- **Docs:** [overview/operational-principles.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/operational-principles.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md)

### NICo (NVIDIA Infra Controller)

An open source suite of microservices for site-local, zero-trust lifecycle management of bare-metal hosts. It handles discovery, firmware, DPU provisioning, network isolation and tenant sanitization, and exposes all of this through APIs.

*conceptual* · from the docs · also called Machine (NICo), ManagedHost, machine, NVIDIA Infra Controller (NICo)

- **Needs:** Bare-metal lifecycle management (ch. 5), Zero-trust host model (ch. 23)
- **Unlocks:** API Service (NICo Core) (ch. 31), NICo scope boundaries (ch. 23), Scale guidance vs hard limit (ch. 25), Rack Management Service (RMS) (ch. 29)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/operational-principles.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/operational-principles.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [overview/scope-and-boundaries.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/scope-and-boundaries.md)

### NICo scope boundaries

NICo covers everything from the physical underlay up to the OS boot handoff. OS management, cluster assembly (Kubernetes/SLURM), workload scheduling and switch configuration belong to the platform or network team.

*conceptual* · from the docs

- **Needs:** NICo (NVIDIA Infra Controller) (ch. 23)
- **Docs:** [overview/scope-and-boundaries.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/scope-and-boundaries.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/operational-principles.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/operational-principles.md)

### Mellanox Device Kind

The factory product class NICo derives from a card's part number. It identifies the SKU and does not change when the card's operating mode changes.

*conceptual* · from the docs

- **Needs:** PN/PSID (ch. 22), DPU mode vs NIC mode (ch. 12)
- **Docs:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### DPU restricted mode

A locked-down DPU mode in which the host cannot reconfigure the DPU. NICo raises an alert if the DPU is not running in it.

*conceptual* · from the docs

- **Needs:** Zero-trust host model (ch. 23)
- **Docs:** [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

<a id="chapter-24"></a>
## Chapter 24: GPU Fabrics

*Part: Networking & Isolation*

Builds on chapters 7, 23.

### Network planes (Ethernet, InfiniBand, NVLink)

The separate fabrics in an AI cluster. Ethernet carries north-south traffic, InfiniBand and Spectrum-X carry east-west GPU traffic, and NVLink connects GPUs. NICo isolates tenants on each of them.

*conceptual* · from the docs

- **Needs:** Multi-tenancy (ch. 23)
- **Unlocks:** InfiniBand partitioning with UFM (P_Key) (ch. 30), InfiniBand fabric (ch. 24), NVLink scale-up fabric (ch. 24)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md)

### InfiniBand fabric

A separate InfiniBand network. Each NIC port connects to one fabric, and a host may span several fabrics.

*conceptual* · from the docs

- **Needs:** Network planes (Ethernet, InfiniBand, NVLink) (ch. 24)
- **Unlocks:** InfiniBand device (NIC port as device) (ch. 30), InfiniBand GUID and LID (ch. 24)
- **Docs:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md)

### NVLink scale-up fabric

The NVLink network that links GPUs across trays in a rack into one larger GPU domain. The fabric manager and telemetry services manage and monitor it.

*conceptual* · from the docs

- **Needs:** Network planes (Ethernet, InfiniBand, NVLink) (ch. 24)
- **Unlocks:** NMX-C / Fabric Manager (ch. 30)
- **Docs:** [architecture/state_machines/switch_configure_certificate.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch_configure_certificate.md), [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md)

### InfiniBand GUID and LID

A GUID is the globally unique hardware ID of an InfiniBand port or VF. A LID is the local address that the subnet manager assigns.

*conceptual* · from the docs

- **Needs:** InfiniBand fabric (ch. 24)
- **Docs:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

### Static network fabric principle

Leaf/spine switches are never reconfigured when tenants change. All tenant isolation is done on DPUs and through fabric manager APIs.

*conceptual* · from the docs

- **Needs:** BlueField DPU (ch. 7), Multi-tenancy (ch. 23)
- **Docs:** [overview/operational-principles.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/operational-principles.md), [overview/scope-and-boundaries.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/scope-and-boundaries.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md)

<a id="chapter-25"></a>
## Chapter 25: Observability

*Part: Health & Operations*

Builds on chapters 23.

### Scale guidance vs hard limit

NICo has no enforced maximum on fleet size. The published figures are the largest fleets measured, each labelled with how it was validated: field deployment, hardware lab, simulation, pre-release simulation, planned certification or roadmap.

*conceptual* · from the docs

- **Needs:** NICo (NVIDIA Infra Controller) (ch. 23)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

### SuperNIC Lockdown

A card mode that blocks firmware and configuration changes unless the card is unlocked with a 64-bit key, so host tenants cannot tamper with the NIC. Losing the key effectively bricks the card.

*conceptual* · from the docs · also called SuperNIC Lockdown and IKM Keys

- **Needs:** Zero-trust host model (ch. 23)
- **Unlocks:** NIC Firmware Recovery Engine (ch. 43), S-VPC (ch. 34), DPA Interface (ch. 34)
- **Docs:** [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Observability stack (Prometheus, Grafana, Loki, OpenTelemetry)

Tools for metrics scraping (Prometheus), dashboards (Grafana), log aggregation (Loki) and telemetry shipping (OpenTelemetry Collector). NICo exports Prometheus metrics and sends logs to Loki.

*conceptual* · from the docs · also called OpenTelemetry (OTEL/OTLP), OTEL, OTLP, OpenTelemetry Collector

- **Unlocks:** Hardware Health service (ch. 36), Loki logging (ch. 25)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

### Prometheus metrics

Time-series counters and histograms that components expose for monitoring. The sizing figures and alert signals come from them.

*conceptual* · from the docs · also called Prometheus, /metrics, ServiceMonitor, metric labels

- **Unlocks:** Hardware Health service (ch. 36)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [architecture/backends/rms.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/backends/rms.md), [getting-started/installation-options/day0-credential-store.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-credential-store.md)

### Loki logging

A log aggregation system queried through Grafana or logcli. It stores logs from control-plane components and host serial consoles.

*conceptual* · from the docs

- **Needs:** Observability stack (Prometheus, Grafana, Loki, OpenTelemetry) (ch. 25)
- **Docs:** [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md)

<a id="chapter-26"></a>
## Chapter 26: Console Access

*Part: Health & Operations*

Builds on chapters 6, 22.

### Alert debouncing

Raising an alert only after a set number of consecutive failed checks, and clearing it on the first success, so short blips are not reported.

*conceptual* · from the docs

- **Unlocks:** NVLink partition monitor (ch. 32), Switch reachability monitor (ch. 49)
- **Docs:** [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

### Health probe ID

A stable identifier for one specific health check, for example BmcSensor or HeartbeatTimeout, used to label alerts and successes in health reports.

*conceptual* · from the docs

- **Docs:** [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

### Building Management System (BMS)

Datacenter facility systems. NICo receives their rack leak events through the DSX Exchange consumer.

*conceptual* · from the docs

- **Unlocks:** Leak detection (ch. 45)
- **Docs:** [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

### BMC sensors and event logs

Redfish endpoints that report temperatures, fan speeds, power readings and BMC/system event log entries. NICo polls them periodically, and fetches logs incrementally.

*conceptual* · from the docs

- **Needs:** Redfish resource tree (Systems, Chassis, Managers) (ch. 6)
- **Unlocks:** Hardware Health service (ch. 36), BMC sensor thresholds (ch. 45), Leak detection (ch. 45)
- **Docs:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [architecture/health_aggregation.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health_aggregation.md)

### SSH public keys

Public keys that authorize a user to log in over SSH. Here they grant access to the host's serial console.

*conceptual* · from the docs

- **Unlocks:** Key group (ch. 26)
- **Docs:** [architecture/key_group_sync.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/key_group_sync.md)

### Serial-over-LAN and SSH Console Service

Serial-over-LAN carries a server's serial console over the BMC network. NICo's SSH Console Service keeps SSH/IPMI connections to BMCs open so admins and tenants get live console access, and the output is logged to Loki.

*conceptual* · from the docs · also called IPMI, Intelligent Platform Management Interface, IPMI over LAN, EnableIpmiOverLan

- **Needs:** Baseboard Management Controller (BMC) (ch. 6), SSH (ch. 22)
- **Unlocks:** Key group (ch. 26)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md)

### Key group

A named set of SSH public keys, stored per tenant, that grants access to the SSH console.

*conceptual* · from the docs

- **Needs:** SSH public keys (ch. 26), Serial-over-LAN and SSH Console Service (ch. 26)
- **Unlocks:** Key group synchronization (ch. 36)
- **Docs:** [architecture/key_group_sync.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/key_group_sync.md)

<a id="chapter-27"></a>
## Chapter 27: DPF Setup

*Part: DOCA Platform Framework*

Builds on chapters 1, 7, 12, 13, 14, 19.

### containerd

The container runtime on each DPU that pulls and runs DPUService images.

*conceptual* · from the docs

- **Needs:** Container registry (ch. 13)
- **Unlocks:** HTTPS/SOCKS5 forward proxy for DPU egress (ch. 37)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### DPU reprovisioning

Reinstalling a DPU's OS. This happens when its flavor or BFB changes, or when an operator triggers it, for example after enabling DPF on an existing host.

*conceptual* · from the docs · also called DPU Reprovision

- **Needs:** DPU BFB (ch. 13)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Kamaji

A tool that runs Kubernetes control planes as pods inside a host cluster. DPF uses it to host the DPU cluster's control plane.

*conceptual* · from the docs

- **Needs:** Kubernetes (ch. 14)
- **Unlocks:** DPUCluster (ch. 37)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### Node Feature Discovery (NFD)

A Kubernetes add-on that labels nodes based on their hardware features. With NICo, nodes are labelled through NFD's own config (PCI class 0200) instead of the NodeFeatureRules bundled with the DPF chart.

*conceptual* · from the docs

- **Needs:** Kubernetes (ch. 14), PCIe device (ch. 1)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### Selectorless Service with manual Endpoints

A Kubernetes pattern: if a Service has no selector and an Endpoints object exists with the same name, Kubernetes uses those endpoints exactly as written. Here a dummy IP is used so the Service routes nothing.

*conceptual* · from the docs

- **Needs:** Kubernetes Service types (LoadBalancer, NodePort, ClusterIP) (ch. 14)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### iPXE-based DPU provisioning

The older, now deprecated NICo way of provisioning DPUs, where they network-boot with iPXE. A host stays on this path when dpf_enabled = false.

*conceptual* · from the docs · also called PXE boot, PXE

- **Needs:** PXE / iPXE boot (ch. 12), BlueField DPU (ch. 7)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

### cert-manager approver-policy

An optional cert-manager component that approves a certificate request only if a matching CertificateRequestPolicy allows it. Without a policy for dpf-operator-system, DPF's certificate requests stay Pending.

*procedural* · from the docs

- **Needs:** cert-manager (ch. 19)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

<a id="chapter-28"></a>
## Chapter 28: GB200 Rack Hardware

*Part: Rack-Scale Systems*

Builds on chapters 6, 7, 13.

### DOCA

NVIDIA's software framework and release train for BlueField DPU functionality.

*conceptual* · from the docs

- **Needs:** BlueField DPU (ch. 7)
- **Docs:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### bf.cfg parameters

Install-time shell variables that the BFB installer sources, for example a hashed password for the DPU's ubuntu user. NICo appends them verbatim to the flavor.

*procedural* · from the docs

- **Needs:** DPU BFB (ch. 13)
- **Unlocks:** DPUFlavor / DPUFlavorTemplate (ch. 37)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### GB200 NVL72 rack

An NVIDIA rack-scale system made of 18 compute trays (hosts), 9 NVLink switch trays and several power shelves. Its GPUs share a single NVLink domain.

*conceptual* · from the docs · also called Compute Tray, ComputeTrays

- **Unlocks:** Maintenance Scope (ch. 29), NVLink switch tray (ch. 28), Power shelf (ch. 28)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [architecture/state_machines/rack.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rack.md)

### NVLink switch tray

A rack tray holding NVLink switches that connect the GPUs in an NVL72 rack. It runs NVOS and has its own BMC.

*conceptual* · from the docs · also called NVLink Switch

- **Needs:** GB200 NVL72 rack (ch. 28), Baseboard Management Controller (BMC) (ch. 6)
- **Unlocks:** Rack profile (ch. 29), Switch State Machine (ch. 47), NMX-C / Fabric Manager (ch. 30)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md), [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md)

### Power shelf

A rack component that supplies power to the trays. It has a BMC and NICo manages it as a device that moves through to the ready state.

*conceptual* · from the docs · also called NVL rack components, compute tray, NVSwitch tray, power shelf

- **Needs:** GB200 NVL72 rack (ch. 28), Baseboard Management Controller (BMC) (ch. 6)
- **Unlocks:** Rack Management Service (RMS) (ch. 29), Host-Based Networking (HBN) (ch. 29)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [architecture/backends/rms.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/backends/rms.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [architecture/health_aggregation.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health_aggregation.md), [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md)

<a id="chapter-29"></a>
## Chapter 29: VPCs & Segments

*Part: Networking & Isolation*

Builds on chapters 6, 7, 11, 12, 17, 19, 23, 28.

### Maintenance Scope

The optional lists of machine, switch and power-shelf IDs to maintain. If all three lists are empty, the whole rack is maintained.

*conceptual* · from the docs

- **Needs:** GB200 NVL72 rack (ch. 28)
- **Unlocks:** On-Demand Rack Maintenance (ch. 48), Rack Maintenance (ch. 48)
- **Docs:** [architecture/state_machines/rack.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rack.md)

### Rack Management Service (RMS)

The service NICo uses for rack-level setup. Simulations use a mock of it.

*conceptual* · from the docs · also called RMS, rack-manager, nv-rms, rms-api-server

- **Needs:** mTLS / gRPC (ch. 19), Power shelf (ch. 28), Redfish API (ch. 6), NICo (NVIDIA Infra Controller) (ch. 23)
- **Unlocks:** Rack profile (ch. 29), Primary Switch (ch. 47), Submission Outcome Semantics (ch. 48)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [architecture/backends/rms.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/backends/rms.md), [architecture/flow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/flow.md), [architecture/state_machines/switch_configure_certificate.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch_configure_certificate.md)

### Rack profile

Configuration in the nico-api chart that says how many compute trays, DPUs, switch trays and power shelves a rack type has. NICo uses it to work out BMC endpoints and machines per rack, for example 71 endpoints and 54 machines for a GB200 NVL72 rack with 2 DPUs per tray.

*conceptual* · from the docs · also called Firmware manifest and rack profile, firmware_object, rack_profiles, apply_firmware_object

- **Needs:** Rack Management Service (RMS) (ch. 29), NVLink switch tray (ch. 28), Helm chart values (ch. 17)
- **Unlocks:** Rack State Machine (ch. 47), SOT JSON (ch. 48)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [architecture/backends/rms.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/backends/rms.md), [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md)

### Host-Based Networking (HBN)

NVIDIA's networking stack that runs Cumulus Linux routing in containers on the DPU, configured through NVUE. NICo uses it to enforce VXLAN/EVPN tenant isolation without changing the physical switches.

*conceptual* · from the docs · also called Host Based Networking (HBN), HBN, DOCA HBN, FRR

- **Needs:** VXLAN / EVPN (ch. 11), BlueField DPU (ch. 7), Power shelf (ch. 28), EVPN (ch. 11)
- **Unlocks:** DOCA Platform Framework (DPF) (ch. 36), Switch mTLS Services (ch. 48), VPC (FNN VPC) (ch. 29)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [overview/operational-principles.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/operational-principles.md), [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

### VPC (FNN VPC)

A tenant's isolated virtual network, set up through the API. In FNN VPCs each instance interface gets a routed /31 link to its DPU gateway, and there is no shared L2 subnet.

*conceptual* · from the docs · also called Tenant VPC, virtual private cloud, VPC, FNN (site fabric isolation)

- **Needs:** VRF (ch. 11), Host-Based Networking (HBN) (ch. 29), Multi-tenancy (ch. 23)
- **Unlocks:** Desired vs actual state reconciliation (ch. 30), InfiniBand partitioning with UFM (P_Key) (ch. 30), NVLink partitioning with NMX-C (ch. 30), HostInband Network Segment (ch. 29), S-VPC (ch. 34)
- **Docs:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [architecture/networking_integrations.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/networking_integrations.md)

### HostInband Network Segment

An underlay segment that a zero-DPU host's NIC attaches to directly. It is the only segment type a Flat VPC accepts.

*conceptual* · from the docs

- **Needs:** VPC (FNN VPC) (ch. 29), DPU mode vs NIC mode (ch. 12), Underlay and HostInband network segments (ch. 12)
- **Unlocks:** Flat VPC (ch. 29)
- **Docs:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### Flat VPC

A VPC type for zero-DPU hosts. NICo allocates addresses and keeps records, but the operator's fabric does the routing and enforcement.

*conceptual* · from the docs

- **Needs:** HostInband Network Segment (ch. 29)
- **Docs:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="chapter-30"></a>
## Chapter 30: State Machine Framework · GPU Fabrics

*Part: NICo Architecture*

Builds on chapters 1, 4, 17, 19, 24, 28, 29.

### InfiniBand partitioning with UFM (P_Key)

InfiniBand isolates traffic with partition keys (P_Keys). NVIDIA's UFM fabric manager assigns them, and NICo calls UFM APIs to put a tenant's ports into that tenant's partition.

*conceptual* · from the docs · also called UFM (Unified Fabric Manager), UFM, InfiniBand Partitioning (P_Key / UFM), P_Key

- **Needs:** Network planes (Ethernet, InfiniBand, NVLink) (ch. 24), VPC (FNN VPC) (ch. 29)
- **Unlocks:** InfiniBand device (NIC port as device) (ch. 30), Force delete of managed host (ch. 40)
- **Docs:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [overview/operational-principles.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/operational-principles.md), [overview/scope-and-boundaries.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/scope-and-boundaries.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

### NMX-C / Fabric Manager

The NVLink fabric management cluster application that runs on the primary switch. The rack's ConfigureNmxCluster step rotates switch certificates, then submits an RMS ScaleUpFabricManager V2 job that picks the primary switch and binds NMX-C.

*conceptual* · from the docs

- **Needs:** NVLink scale-up fabric (ch. 24), NVLink switch tray (ch. 28)
- **Unlocks:** NVLink partitioning with NMX-C (ch. 30), Primary Switch (ch. 47)
- **Docs:** [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md), [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md), [architecture/state_machines/switch_configure_certificate.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch_configure_certificate.md)

### NVLink partitioning with NMX-C

NMX-C is the NVLink fabric controller. NICo uses its gRPC API to place GPUs into tenant NVLink logical partitions and to check that the NVLink domain is healthy before allocating instances.

*conceptual* · from the docs · also called NMX Controller (NMX-C), NMX-C, NVLink partition, partition monitor

- **Needs:** VPC (FNN VPC) (ch. 29), NMX-C / Fabric Manager (ch. 30), mTLS / gRPC (ch. 19)
- **Unlocks:** NVLink partition monitor (ch. 32), Maintenance Activities (ch. 48)
- **Docs:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [overview/scope-and-boundaries.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/scope-and-boundaries.md), [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md)

### InfiniBand device (NIC port as device)

A physical PCI function that can send InfiniBand traffic. NICo presents each port of a multi-port NIC as a separate device.

*conceptual* · from the docs

- **Needs:** PCI device and slot address (ch. 1), InfiniBand partitioning with UFM (P_Key) (ch. 30), InfiniBand fabric (ch. 24)
- **Unlocks:** InstanceInfinibandConfig (ch. 44)
- **Docs:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md)

### Desired vs actual state reconciliation

A control pattern where requests record what should be true and background loops keep acting until the real system matches it.

*conceptual* · from the docs · also called reconciliation, configs_synced

- **Needs:** VPC (FNN VPC) (ch. 29)
- **Unlocks:** State machine (resource lifecycle) (ch. 30), NVLink partition monitor (ch. 32)
- **Docs:** [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [architecture/networking_integrations.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/networking_integrations.md)

### State machine (resource lifecycle)

A model where each managed resource, such as a host or network segment, moves through defined states (for example Decommissioning/Decommissioned) with controlled transitions between them.

*conceptual* · from the docs · also called NICo state machines, State Machines, ManagedHost state machine, State controller

- **Needs:** Desired vs actual state reconciliation (ch. 30), Database transaction (ch. 4)
- **Unlocks:** API Service (NICo Core) (ch. 31), State controller work queue and claims (ch. 30), Recovery point and crash-window reconciliation (ch. 30), Service-level agreement (SLA) for states (ch. 30), Switch State Machine (ch. 47), Power Shelf State Machine (ch. 47), State Controller Tick (ch. 31), State History and Manual Intervention Alerts (ch. 36), Controller State Persistence (ch. 30), DPA Interface (ch. 34)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [architecture/state_handling.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_handling.md)

### Recovery point and crash-window reconciliation

Before an external call, persist enough durable state to resume or reconcile it after a crash. Afterwards, classify the result as absent, complete, partial/unwanted or unknown, and act safely, failing closed when unsure.

*procedural* · from the docs

- **Needs:** Idempotency (ch. 4), State machine (resource lifecycle) (ch. 30)
- **Unlocks:** Tracked Dispatch (ch. 43)
- **Docs:** [architecture/state_handling.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_handling.md)

### Service-level agreement (SLA) for states

A time limit for how long a resource should stay in a given lifecycle state. When it is exceeded, the framework records an SLA error that deployments can alert on.

*conceptual* · from the docs

- **Needs:** State machine (resource lifecycle) (ch. 30)
- **Unlocks:** Maintenance mode (ch. 44)
- **Docs:** [architecture/state_handling.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_handling.md)

### State controller work queue and claims

Resources are queued periodically, after transitions, or on explicit request. A processor then claims them in the database and handles them with bounded concurrency and a timeout. Another processor can reclaim a claim that has gone stale.

*conceptual* · from the docs

- **Needs:** State machine (resource lifecycle) (ch. 30)
- **Unlocks:** State handler outcomes (ch. 31)
- **Docs:** [architecture/state_handling.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_handling.md)

### Controller State Persistence

Each device's current state and sub-state are stored as JSON in a PostgreSQL column, such as switches.controller_state. This lets a restarted controller continue where it left off.

*conceptual* · from the docs

- **Needs:** PostgreSQL (Zalando operator) (ch. 17), State machine (resource lifecycle) (ch. 30)
- **Unlocks:** Asynchronous job polling (ch. 31)
- **Docs:** [architecture/state_machines/switch_configure_certificate.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch_configure_certificate.md), [architecture/state_machines/power_shelf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/power_shelf.md)

<a id="chapter-31"></a>
## Chapter 31: Control Plane Services · State Machine Framework

*Part: NICo Architecture*

Builds on chapters 4, 17, 18, 19, 23, 30.

### State Controller Tick

The periodic loop in which a state handler reloads an object from the database, checks its config flags, and performs any transition. A gRPC call only sets a flag; the actual transition happens on a later tick.

*conceptual* · from the docs

- **Needs:** State machine (resource lifecycle) (ch. 30), mTLS / gRPC (ch. 19)
- **Unlocks:** On-Demand Rack Maintenance (ch. 48), On-Demand Maintenance (ch. 48)
- **Docs:** [architecture/state_machines/rack.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rack.md)

### Asynchronous job polling

A pattern where a request returns a job ID right away, and the caller polls a status API until the job reaches completed or failed.

*procedural* · from the docs · also called Asynchronous Job Polling, job_id, WaitForComplete, parent/child jobs

- **Needs:** Controller State Persistence (ch. 30)
- **Unlocks:** Submission Outcome Semantics (ch. 48), Redfish Task Service (ch. 32)
- **Docs:** [architecture/backends/rms.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/backends/rms.md), [architecture/state_machines/switch_configure_certificate.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch_configure_certificate.md), [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md), [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md)

### State handler outcomes

What a handler returns from one pass. Wait and DoNothing keep the state. Transition stores the next state and requeues. Deleted removes the queue claim.

*conceptual* · from the docs

- **Needs:** State controller work queue and claims (ch. 30)
- **Unlocks:** Iteration invalidation (ch. 31)
- **Docs:** [architecture/state_handling.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_handling.md)

### Iteration invalidation

When a conditional state write is rejected, the processor rolls back all writes from that iteration and immediately requeues the resource to reload fresh state. This is not recorded as an error.

*conceptual* · from the docs

- **Needs:** Optimistic concurrency / stale-write protection (ch. 4), State handler outcomes (ch. 31)
- **Docs:** [architecture/state_handling.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_handling.md)

### API Service (NICo Core)

NICo's central control-plane service and single source of truth. It is the only service that reads and writes PostgreSQL, it implements state machines for managed resources, and other services talk to it over mTLS/gRPC.

*conceptual* · from the docs · also called nico-api, carbide-api, NICo Core, Infra Controller Core

- **Needs:** mTLS / gRPC (ch. 19), State machine (resource lifecycle) (ch. 30), NICo (NVIDIA Infra Controller) (ch. 23), Site Controller (ch. 18), PostgreSQL (Zalando operator) (ch. 17)
- **Unlocks:** DPU Agent (ch. 38), API admission control (ch. 32), NICo REST (JSON API) (ch. 31), Admin CLI (ch. 31), siteConfig (site TOML configuration) (ch. 33), nico-dhcp and Kea hook (ch. 32), Hardware Health service (ch. 36), Firmware Supervisor and Receipt (ch. 35)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

### Admin CLI

A command-line tool for site administrators that connects directly to the API Service over mTLS/gRPC. It is used, for example, to set site-wide credentials.

*procedural* · from the docs · also called nico-admin-cli, admin-cli, admin CLI, forge-admin-cli

- **Needs:** API Service (NICo Core) (ch. 31)
- **Unlocks:** Site-wide BMC and UEFI credentials (ch. 34)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md), [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

### NICo REST (JSON API)

The REST API that exposes NICo to operators and ISVs, authenticated with JWT. It can be deployed next to the site controller or centrally in the cloud, serving multiple sites.

*conceptual* · from the docs · also called NICo REST and Site Agent, nico-rest, Site Agent, siteId

- **Needs:** OIDC / JWT authentication (Keycloak) (ch. 19), API Service (NICo Core) (ch. 31)
- **Unlocks:** Site Agent (ch. 31), Org bootstrap (InfrastructureProvider, Tenant, TenantAccount) (ch. 33), nicocli (ch. 31)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

### Site Agent

A site-controller service that keeps a Temporal connection to NICo REST. It syncs data and passes requests on to the local API Service, so NICo REST can run centrally while sites run on-premises.

*conceptual* · from the docs · also called NICo REST site-agent, site-agent, nico-rest-site-agent, site-manager

- **Needs:** Temporal workflow engine (ch. 4), NICo REST (JSON API) (ch. 31)
- **Unlocks:** Site and site UUID registration (ch. 33), Key group synchronization (ch. 36)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### nicocli

The CLI for the NICo REST API, built from rest-api/. It is used for site management, org bootstrap and instance operations.

*procedural* · from the docs

- **Needs:** NICo REST (JSON API) (ch. 31), OAuth2 client credentials flow and JWT bearer tokens (ch. 19)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="chapter-32"></a>
## Chapter 32: BMC & Redfish (part 2)

*Part: Hardware & OOB Management*

Builds on chapters 6, 8, 21, 26, 30, 31.

### Redfish Task Service

Redfish resources that track long-running asynchronous operations, such as firmware updates, so a client can poll for completion.

*conceptual* · from the docs

- **Needs:** Redfish API (ch. 6), Asynchronous job polling (ch. 31)
- **Unlocks:** Firmware inventory and update (ch. 32)
- **Docs:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

### Firmware inventory and update

The Redfish UpdateService lists firmware components and their versions and accepts firmware updates. NICo compares these versions with its configuration to decide on upgrades.

*conceptual* · from the docs

- **Needs:** Redfish resource tree (Systems, Chassis, Managers) (ch. 6), Redfish Task Service (ch. 32)
- **Unlocks:** Firmware baseline enforcement (ch. 35), Preingestion Manager (ch. 38), Host Reprovision (ch. 40), Managed Artifact Cache (ch. 35)
- **Docs:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

### NVLink partition monitor

A periodic nico-api task that reconciles NVLink partitions with NMX-C. It raises NmxcUnreachable and NvlinkUnhealthy alerts and performs isolation.

*conceptual* · from the docs

- **Needs:** NVLink partitioning with NMX-C (ch. 30), Alert debouncing (ch. 26), Desired vs actual state reconciliation (ch. 30)
- **Unlocks:** NVLink isolation (ch. 45)
- **Docs:** [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md), [architecture/health/health_alert_classifications.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_alert_classifications.md)

### nico-dhcp and Kea hook

NICo's central DHCP service, built as a Kea DHCP server hook. It is a stateless proxy that turns DHCP requests into gRPC discover_dhcp calls to Core, which assigns the IP addresses.

*conceptual* · from the docs · also called Kea DHCP server with NICo hook

- **Needs:** DHCP (ch. 8), API Service (NICo Core) (ch. 31)
- **Docs:** [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

### API admission control

A nico-api setting, on by default, that limits how many requests run and wait in a queue, both in total and per client. Disable it for simulated fleets, because all simulated agents share one client identity. Keep it on with real hardware and watch the rejection counter.

*conceptual* · from the docs

- **Needs:** API Service (NICo Core) (ch. 31), Client identity (ch. 21)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

<a id="chapter-33"></a>
## Chapter 33: Installation & Setup

*Part: Kubernetes & Deployment*

Builds on chapters 1, 17, 19, 31.

### siteConfig (site TOML configuration)

A TOML block in nico-core.yaml that defines the site's identity, DHCP and NTP servers, fabric prefixes, deny prefixes, resource pools and initial networks.

*procedural* · from the docs · also called Helm charts and values, Helm, helm-prereqs, extraEnv

- **Needs:** TOML (ch. 1), API Service (NICo Core) (ch. 31)
- **Unlocks:** Credential store (Vault vs Postgres) (ch. 34), Admin and underlay networks (ch. 33)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/day0-credential-store.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-credential-store.md), [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md), [architecture/backends/rms.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/backends/rms.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### Org bootstrap (InfrastructureProvider, Tenant, TenantAccount)

A one-time GET call to the REST API. It lazily creates the org's InfrastructureProvider, a Tenant, and a TenantAccount linking them. Site operations return 404 until it has been called.

*procedural* · from the docs

- **Needs:** OAuth2 client credentials flow and JWT bearer tokens (ch. 19), NICo REST (JSON API) (ch. 31)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

### Site and site UUID registration

Each NICo installation manages exactly one site, which has a stable UUID. setup.sh reuses, adopts or mints the UUID and registers the site automatically, so you must not create sites manually.

*conceptual* · from the docs

- **Needs:** Site Agent (ch. 31), setup.sh orchestrator (ch. 17)
- **Unlocks:** Upgrade and teardown (ch. 33)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

### Upgrade and teardown

To upgrade, re-run setup.sh with new image tags; it preserves Vault, Postgres, MetalLB config and the site UUID. clean.sh removes all NICo components, namespaces and released volumes.

*procedural* · from the docs

- **Needs:** Site and site UUID registration (ch. 33)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

### Admin and underlay networks

Networks NICo creates at startup. The admin network carries host management traffic. Underlay data-plane networks are defined one per L3 segment. An IPv4 prefix needs a gateway.

*conceptual* · from the docs

- **Needs:** siteConfig (site TOML configuration) (ch. 33)
- **Unlocks:** Admin network isolation (ch. 42)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="chapter-34"></a>
## Chapter 34: Credentials & Secrets · SuperNIC Lockdown

*Part: Security & Identity*

Builds on chapters 7, 18, 19, 20, 25, 29, 30, 31, 33.

### S-VPC

A non-ASTRA deployment flavour (for example on BF3) where SuperNICs are flashed so that NICo must manage their lockdown keys.

*conceptual* · from the docs

- **Needs:** SuperNIC Lockdown (ch. 25), VPC (FNN VPC) (ch. 29)
- **Docs:** [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md)

### DPA Interface

NICo's record and lifecycle for a SuperNIC attached to a host. It moves through Unlocking, firmware/profile application, Locking and Assigned.

*conceptual* · from the docs

- **Needs:** SuperNIC Lockdown (ch. 25), State machine (resource lifecycle) (ch. 30), DPA (Data Path Accelerator) (ch. 7)
- **Unlocks:** Lockdown IKM Rotation (ch. 35)
- **Docs:** [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md)

### Site-wide BMC and UEFI credentials

Site-managed passwords that NICo sets on host/DPU BMCs and UEFI after it takes over from the factory defaults. They must be configured before ingestion starts.

*procedural* · from the docs · also called site-wide-root, UEFI password, bmcSiteWideRootSource, version 0 credential

- **Needs:** Admin CLI (ch. 31), Factory default credentials (ch. 20)
- **Unlocks:** Hardware discovery and ingestion (ch. 38)
- **Docs:** [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

### Credential store (Vault vs Postgres)

Where NICo keeps BMC and UEFI credentials. It is Vault by default, or PostgreSQL when the site is installed without Vault. In the Postgres case, certificates come from the site-issuer ClusterIssuer instead.

*conceptual* · from the docs · also called NICo credential store (secrets backends), [secrets], Postgres secrets backend, KEK provider

- **Needs:** HashiCorp Vault (ch. 20), Envelope encryption and KEK (ch. 18), siteConfig (site TOML configuration) (ch. 33), cert-manager (ch. 19)
- **Unlocks:** Input Key Material (IKM) (ch. 35), Credential source modes (local / local_first / backend) (ch. 34)
- **Docs:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/day0-credential-store.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-credential-store.md), [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md), [architecture/state_machines/switch_configure_certificate.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch_configure_certificate.md), [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md)

### Credential source modes (local / local_first / backend)

Settings that decide where NICo reads the BMC root from: a locally mounted file or environment variable, or a persistent backend such as Vault or Postgres. In local mode, version 0 must exist before Core starts.

*conceptual* · from the docs

- **Needs:** Site-wide BMC root credential (ch. 20), Credential store (Vault vs Postgres) (ch. 34)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

<a id="chapter-35"></a>
## Chapter 35: SuperNIC Lockdown · Validation & Updates

*Part: Host Lifecycle*

Builds on chapters 4, 5, 19, 31, 32, 34.

### Input Key Material (IKM)

The secret, high-entropy, site-wide value that all lockdown keys are derived from. It is versioned and kept in the credential store, and the key cannot be re-derived without the exact version used.

*conceptual* · from the docs

- **Needs:** Entropy and Offline Guessing (ch. 19), Credential store (Vault vs Postgres) (ch. 34)
- **Unlocks:** Lockdown IKM Rotation (ch. 35), NIC Firmware Recovery Engine (ch. 43), HKDF-SHA256 (ch. 42)
- **Docs:** [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md)

### Lockdown IKM Rotation

Creating a new IKM version and moving cards to it. Cards migrate at allocation or through idle unlock/re-lock, and the version chosen depends on in-flight, current and site-target bookkeeping.

*procedural* · from the docs

- **Needs:** Input Key Material (IKM) (ch. 35), DPA Interface (ch. 34)
- **Docs:** [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md)

### Firmware Supervisor and Receipt

The local daemon that performs firmware work, plus the receipt Core saves that records which work it accepted and the results. Core uses receipts to resume after restarts without repeating writes.

*conceptual* · from the docs

- **Needs:** API Service (NICo Core) (ch. 31), Idempotency (ch. 4)
- **Unlocks:** NIC Firmware Execution Phases (ch. 43)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Firmware baseline enforcement

Taking inventory of UEFI/BMC firmware and updating hosts to a site-defined baseline. Hosts that cannot be brought to the baseline are quarantined. Later updates are scheduled on healthy, unoccupied hosts.

*procedural* · from the docs

- **Needs:** UEFI firmware and Secure Boot (ch. 5), Firmware inventory and update (ch. 32)
- **Unlocks:** Machine Update Manager (ch. 39), NIC Firmware Baseline Policy (ch. 36), SOT JSON (ch. 48)
- **Docs:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md)

### Managed Artifact Cache

Storage for firmware artifacts. Admitted operations pin their artifacts by digest so they are not evicted during use.

*conceptual* · from the docs

- **Needs:** Firmware inventory and update (ch. 32)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

<a id="chapter-36"></a>
## Chapter 36: Hardware Monitoring

*Part: Health & Operations*

Builds on chapters 4, 5, 14, 22, 25, 26, 29, 30, 31, 35.

### NIC Firmware Baseline Policy

The target firmware chosen per card, machine or site, in that order of precedence. A change only proceeds if the platform (sys_vendor/product_name) and the card (PN/PSID) exactly match the allow-list.

*conceptual* · from the docs

- **Needs:** PN/PSID (ch. 22), DMI Platform Identity (ch. 5), Firmware baseline enforcement (ch. 35)
- **Unlocks:** NIC Firmware Recovery Engine (ch. 43), NIC Readiness Qualification and Restoration Obligations (ch. 41)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### State History and Manual Intervention Alerts

Diagnostic tools for stuck hosts. State history shows past transitions and errors, and alerts fire when the controller needs an operator to step in.

*procedural* · from the docs

- **Needs:** State machine (resource lifecycle) (ch. 30)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Hardware Health service

A NICo service that scrapes host and DPU BMCs over Redfish for sensor data and firmware inventory. It exposes /metrics and /telemetry and reports health alerts to the API Service.

*conceptual* · from the docs · also called nico-hw-health, hardware health service, FirmwareCollector, Hardware Health Monitor

- **Needs:** Observability stack (Prometheus, Grafana, Loki, OpenTelemetry) (ch. 25), Prometheus metrics (ch. 25), BMC sensors and event logs (ch. 26), API Service (NICo Core) (ch. 31)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [architecture/health_aggregation.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health_aggregation.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

### Key group synchronization

The process in which the cloud REST API pushes versioned key group contents to sites, records which version each site holds, and compares versions to find out of sync sites.

*procedural* · from the docs

- **Needs:** Key group (ch. 26), Optimistic concurrency / stale-write protection (ch. 4), Site Agent (ch. 31)
- **Docs:** [architecture/key_group_sync.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/key_group_sync.md)

### DOCA Platform Framework (DPF)

NVIDIA's framework for provisioning and orchestrating services on DPUs. NICo provisions DPUs through it, and scale tests use a DPF simulator in its place.

*conceptual* · from the docs · also called DPF, dpf-operator, doca-platform, DPF operator

- **Needs:** Kubernetes Custom Resource (CR/CRD) (ch. 14), Host-Based Networking (HBN) (ch. 29)
- **Unlocks:** Hardware discovery and ingestion (ch. 38), DPFOperatorConfig (ch. 37), DPU Agent (ch. 38), DPUCluster (ch. 37), DPUFlavor / DPUFlavorTemplate (ch. 37), DPF maintenance hold (NodeEffect) (ch. 37)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

<a id="chapter-37"></a>
## Chapter 37: DPF Custom Resources · Rollout & Reprovisioning

*Part: DOCA Platform Framework*

Builds on chapters 6, 14, 27, 28, 36.

### DPF maintenance hold (NodeEffect)

A DPF phase where a DPU waits behind a maintenance hold before a disruptive change is applied. The DPU keeps serving traffic while it waits.

*conceptual* · from the docs

- **Needs:** DOCA Platform Framework (DPF) (ch. 36)
- **Unlocks:** DPUService rollout gating (ch. 46)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### DPFOperatorConfig

The operator-level DPF custom resource. For NICo it disables DPU auto-detection, turns on Redfish-based install, and sets the API server VIP and port, the Argo CD namespace, the MTU and the pull secrets.

*procedural* · from the docs

- **Needs:** DOCA Platform Framework (DPF) (ch. 36), Redfish API (ch. 6)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### DPUCluster

The DPF custom resource that defines the Kubernetes control plane DPU nodes join. Here it is Kamaji-based and reached through a keepalived VIP.

*conceptual* · from the docs

- **Needs:** Kamaji (ch. 27), Virtual IP address (VIP) (ch. 14), DOCA Platform Framework (DPF) (ch. 36)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### DPUFlavor / DPUFlavorTemplate

The DPF custom resource that describes a DPU's OS configuration, such as bf.cfg parameters and the proxy drop-in. Its name includes a hash of its spec, so any change creates a new flavor and triggers DPU reprovisioning. Astra uses a Go-template variant.

*conceptual* · from the docs

- **Needs:** bf.cfg parameters (ch. 28), DOCA Platform Framework (DPF) (ch. 36)
- **Unlocks:** DPUDeployment (ch. 46), HTTPS/SOCKS5 forward proxy for DPU egress (ch. 37)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### HTTPS/SOCKS5 forward proxy for DPU egress

An optional proxy that DPUs route image pulls through. NICo puts it into a containerd systemd drop-in inside the DPUFlavor, so changing it triggers reprovisioning.

*procedural* · from the docs

- **Needs:** containerd (ch. 27), DPUFlavor / DPUFlavorTemplate (ch. 37)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

<a id="chapter-38"></a>
## Chapter 38: Discovery & Ingestion (part 2)

*Part: Host Lifecycle*

Builds on chapters 3, 5, 6, 8, 13, 14, 17, 20, 22, 31, 32, 34, 36.

### DPU Agent

A persistent daemon on the DPU's ARM OS. Every 30 seconds it asks the API Service for the desired network configuration, applies it through HBN, and reports back the state it observes. It also handles health checks and updates.

*conceptual* · from the docs · also called DPUService, mandatory DPUServices, dts, doca_hbn

- **Needs:** API Service (NICo Core) (ch. 31), Helm and helmfile (ch. 17), DOCA Platform Framework (DPF) (ch. 36)
- **Unlocks:** DPUService CR set (Interface/Template/Configuration/NAD) (ch. 46), Metadata Service (FMDS) (ch. 41), DPU agent bootstrap CA (ch. 38), Network security group (ch. 38), Network Configuration Version Acknowledgement (ch. 38)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### Network security group

A set of tenant firewall rules that the DPU agent enforces. A group is limited to 200 expanded rules by default.

*conceptual* · from the docs

- **Needs:** DPU Agent (ch. 38), Firewall rules (ch. 3)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

### Network Configuration Version Acknowledgement

DPU agents report which version of the desired network configuration they have applied. NICo waits until the reported versions match the desired versions before moving on.

*conceptual* · from the docs

- **Needs:** DPU Agent (ch. 38)
- **Unlocks:** Live Network Update (ch. 46)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### DPU agent bootstrap CA

The policy for how the DPU agent gets the root CA it uses to trust the NICo API: by the legacy download or from a mounted Secret or ConfigMap. Includes a procedure for rotating the root using an overlap bundle.

*procedural* · from the docs

- **Needs:** DPU Agent (ch. 38), Kubernetes Secret (ch. 14)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### Hardware discovery and ingestion

NICo's zero-touch Day 0 process. It finds BMCs over the OOB network, collects inventory through Redfish, pairs DPUs to hosts using LLDP and serial numbers, and brings hosts under management.

*procedural* · from the docs · also called Site explorer, explorations_per_run, machines_created_per_run, concurrent_explorations

- **Needs:** Redfish API (ch. 6), DHCP (ch. 8), LLDP (ch. 22), Expected Machines Manifest (ch. 22), Site-wide BMC and UEFI credentials (ch. 34), TPM and Measured Boot attestation (ch. 20), DOCA Platform Framework (DPF) (ch. 36), Site-wide BMC root credential (ch. 20)
- **Unlocks:** Preingestion Manager (ch. 38), Managed Host (ch. 39), Scout (ch. 41), SKU validation and burn-in (ch. 39), Machine ID (ch. 38)
- **Docs:** [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

### Preingestion Manager

A Core module that updates firmware, runs resets and recovers DPU BFB images on hosts that are too old to be ingested normally.

*conceptual* · from the docs

- **Needs:** Hardware discovery and ingestion (ch. 38), Firmware inventory and update (ch. 32), DPU BFB (ch. 13), Power control reset types (ch. 6)
- **Docs:** [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md)

### Machine ID

NICo's stable identifier for a machine. It is generated by hashing DMI data such as the system serial number and manufacturer, so a missing serial number breaks identification.

*conceptual* · from the docs · also called MachineId

- **Needs:** Redfish resource tree (Systems, Chassis, Managers) (ch. 6), DMI Platform Identity (ch. 5), Hardware discovery and ingestion (ch. 38)
- **Unlocks:** KDF Context (ch. 42), Targeted instance creation (ch. 46)
- **Docs:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md), [architecture/state_machines/rack.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rack.md)

<a id="chapter-39"></a>
## Chapter 39: Validation & Updates · Tenants & Instances

*Part: Host Lifecycle*

Builds on chapters 35, 38.

### Managed Host

A host server paired with one or more BlueField DPUs that NICo manages. The DPUs act as the enforcement boundary for network isolation and security.

*conceptual* · from the docs · also called ManagedHost, ManagedHost and ManagedHostState, managed host, host

- **Needs:** Hardware discovery and ingestion (ch. 38)
- **Unlocks:** Instance and instance type (ch. 39), State controller concurrency (ch. 42), Machine Update Manager (ch. 39), HealthReport (ch. 44), Host DPU Policy (ch. 41)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [architecture/state_handling.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_handling.md)

### SKU validation and burn-in

Checking that each machine has the expected hardware components for its SKU, then running hardware and connectivity tests (including NVLink and InfiniBand multi-node tests) before the host is made available.

*procedural* · from the docs · also called Machine validation, machine-validation-runner, machine-validation-config, host validation tests

- **Needs:** Hardware discovery and ingestion (ch. 38)
- **Unlocks:** Managed Host Lifecycle (ch. 40)
- **Docs:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Machine Update Manager

A Core scheduler that picks hosts and DPUs with outdated firmware for automatic updates. The ManagedHost state machine then carries out the updates.

*conceptual* · from the docs

- **Needs:** Firmware baseline enforcement (ch. 35), Managed Host (ch. 39)
- **Unlocks:** Managed-Machine Update Scheduling Budget (ch. 39)
- **Docs:** [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md)

### Managed-Machine Update Scheduling Budget

A shared limit on how many hosts can do firmware updates at once. If both limits are unset, capacity is zero and changed NIC work stays pending.

*conceptual* · from the docs

- **Needs:** Machine Update Manager (ch. 39)
- **Unlocks:** NIC Firmware Recovery Engine (ch. 43)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Instance and instance type

An instance is a host allocated to a tenant. An instance type is an operator-defined hardware class used to request hosts through the API.

*conceptual* · from the docs

- **Needs:** Managed Host (ch. 39)
- **Unlocks:** Tenant sanitization (ch. 40), Tenant instance (ch. 39), Machine capabilities and instance types (ch. 43)
- **Docs:** [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [overview/scope-and-boundaries.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/scope-and-boundaries.md)

### Tenant instance

A tenant workload allocated to a host. Releasing a hold on a host with an instance disrupts that tenant, so the operator must name the instance explicitly.

*conceptual* · from the docs · also called Instance (bare metal instance), Instance, InstanceConfig, InstanceStatus

- **Needs:** Instance and instance type (ch. 39)
- **Unlocks:** DPUService rollout gating (ch. 46), Metadata Service (FMDS) (ch. 41), Health alert classifications (ch. 44), Repair workflow (ch. 39), Managed-Host Reset (ch. 40)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md), [architecture/networking_integrations.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/networking_integrations.md), [architecture/health_aggregation.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health_aggregation.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md), [architecture/health/health_alert_classifications.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_alert_classifications.md)

### Repair workflow

A flow in which tenants report broken hosts on release, or flag instances for online repair, so an external framework can fix them.

*conceptual* · from the docs

- **Needs:** Tenant instance (ch. 39)
- **Docs:** [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md), [architecture/health/health_alert_classifications.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_alert_classifications.md)

<a id="chapter-40"></a>
## Chapter 40: Managed Host States

*Part: Host Lifecycle*

Builds on chapters 6, 7, 22, 30, 32, 39.

### Tenant sanitization

The cleanup after a tenant releases a host. It includes secure disk erase, memory-overwrite verification, IB reset, TPM clear, re-attestation, and network cleanup that only counts as complete once the DPU confirms it has left all tenant networks.

*procedural* · from the docs

- **Needs:** Secure Erase (ch. 22), Instance and instance type (ch. 39)
- **Unlocks:** BOSS Controller (ch. 40)
- **Docs:** [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md)

### BOSS Controller

A Dell boot-drive controller. NICo securely erases it and recreates its volume during cleanup.

*conceptual* · from the docs

- **Needs:** Tenant sanitization (ch. 40)
- **Unlocks:** Managed Host Lifecycle (ch. 40)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Managed Host Lifecycle

The main sequence of top-level states a managed host goes through: DPU discovery, DPU initialization, host initialization, Ready, Assigned to an instance, and cleanup. There are side paths for validation, reprovisioning, measuring, failure and decommissioning.

*conceptual* · from the docs · also called WaitingForCleanup (Deprovision Cleanup), HostCleanup, SecureEraseBoss, CreateBossVolume

- **Needs:** BOSS Controller (ch. 40), SKU validation and burn-in (ch. 39)
- **Unlocks:** DPUService rollout gating (ch. 46), Decommissioning (ch. 40), Failed State and Failure Causes (ch. 40), NIC Firmware Recovery Engine (ch. 43), Rack State Machine (ch. 47), Host Reprovision (ch. 40), Admin network isolation (ch. 42), Managed-Host Reset (ch. 40), Disable Onboard NICs (Vera Rubin) (ch. 40), NIC Readiness Qualification and Restoration Obligations (ch. 41)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md), [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [architecture/state_machines/rack.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rack.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### Decommissioning

The terminal path from Ready. It resets host and DPU configuration, suppresses DHCP for the host's MACs, factory-resets the BMCs, and deletes per-device credentials.

*procedural* · from the docs · also called Decommissioned, DHCP Suppression Acknowledgement, SuppressingBmcDhcp, SuppressingNvosDhcp

- **Needs:** Out-of-Band (OOB) Interface (ch. 7), Managed Host Lifecycle (ch. 40)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md), [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md), [architecture/state_machines/power_shelf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/power_shelf.md)

### Disable Onboard NICs (Vera Rubin)

A HostInit step only for Vera Rubin hosts with managed DPUs. It enables and then disables the onboard NICs through the BMC, with persisted 10-second waits between the writes.

*procedural* · from the docs

- **Needs:** Managed Host Lifecycle (ch. 40)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Failed State and Failure Causes

A state recording why a host failed, such as BIOS setup, discovery, measurement or validation failures. Some causes recover automatically once the condition clears, others need an admin.

*conceptual* · from the docs

- **Needs:** Managed Host Lifecycle (ch. 40)
- **Unlocks:** Force delete of managed host (ch. 40)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Host Reprovision

Updating host firmware through the BMC, either by uploading images or by running scripts, followed by a reset and verification. It can run from Ready or Assigned.

*procedural* · from the docs · also called M_HostReprovision, FailedFirmwareUpgrade, WaitingForRackFirmwareUpgrade, Firmware Upgrade / Host Reprovision

- **Needs:** Managed Host Lifecycle (ch. 40), Firmware inventory and update (ch. 32), Power control reset types (ch. 6)
- **Unlocks:** Rack Maintenance (ch. 48)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md), [architecture/state_machines/rack.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rack.md), [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md), [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md)

### Managed-Host Reset

An admin-requested reset that deletes the instance and re-ingests the host. It is the supported way to recover a parked NIC firmware failure.

*procedural* · from the docs

- **Needs:** Managed Host Lifecycle (ch. 40), Tenant instance (ch. 39)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Force delete of managed host

Removing a host without the normal deprovisioning states. Extra logic is then needed to detach it from external fabric partitions.

*conceptual* · from the docs · also called Force Deletion

- **Needs:** Failed State and Failure Causes (ch. 40), InfiniBand partitioning with UFM (P_Key) (ch. 30)
- **Docs:** [architecture/networking_integrations.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/networking_integrations.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

<a id="chapter-41"></a>
## Chapter 41: Host & DPU Agents

*Part: NICo Architecture*

Builds on chapters 17, 36, 38, 39, 40.

### NIC Readiness Qualification and Restoration Obligations

Persisted flags saying a NIC card must be restored to baseline or re-qualified through host preparation before allocation. They survive reset and admission being disabled.

*conceptual* · from the docs

- **Needs:** NIC Firmware Baseline Policy (ch. 36), Managed Host Lifecycle (ch. 40)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Scout

A temporary agent that runs on the x86 host during discovery. It collects hardware inventory that cannot be gathered out-of-band, runs validation tests, and reports to the API Service.

*conceptual* · from the docs · also called scout, nico-scout, scout agent

- **Needs:** Hardware discovery and ingestion (ch. 38)
- **Unlocks:** Machine validation tests (ch. 45), Discovery data (ch. 43), SKU validation (ch. 45), NIC Firmware Recovery Engine (ch. 43)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [architecture/networking_integrations.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/networking_integrations.md), [architecture/health_aggregation.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health_aggregation.md)

### Metadata Service (FMDS)

A service on the DPU that gives tenant workloads instance metadata, such as machine ID and boot info, through a local HTTP API on the host-facing interface.

*conceptual* · from the docs · also called FMDS metadata service, FMDS, carbide-fmds, 169.254.169.254

- **Needs:** DPU Agent (ch. 38), Tenant instance (ch. 39)
- **Unlocks:** IPv6 metadata transport (ch. 41), Machine identity (JWT-SVID issuance) (ch. 43)
- **Docs:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md)

### IPv6 metadata transport

An optional setup that serves FMDS metadata over IPv6. It needs overlays on both the DPU agent chart (to select the HBN peer) and the FMDS chart (for the listener and address).

*procedural* · from the docs

- **Needs:** Metadata Service (FMDS) (ch. 41), Helm chart values (ch. 17)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### Host DPU Policy

The operator's chosen treatment of DPU hardware on a host. `Manage` lets NICo provision the DPUs, `Nic` runs them as plain NICs, and `Ignore` leaves them unconfigured. It records intent, not what the hardware is actually doing.

*conceptual* · from the docs

- **Needs:** Managed Host (ch. 39)
- **Docs:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="chapter-42"></a>
## Chapter 42: Scale & Sizing · SuperNIC Lockdown

*Part: Kubernetes & Deployment*

Builds on chapters 16, 18, 33, 35, 38, 39, 40.

### Admin network isolation

An internal NICo setting that overrides the tenant's network configuration and places the machine on an isolated admin network. This is used during provisioning and termination.

*conceptual* · from the docs

- **Needs:** Admin and underlay networks (ch. 33), Managed Host Lifecycle (ch. 40)
- **Docs:** [architecture/networking_integrations.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/networking_integrations.md)

### State controller concurrency

The machine state controller moves at most max_concurrency machines through their states at once (10 by default, 80 to 120 recommended for large sites). This setting, not the number of CPU cores, sets how long a fleet takes to become ready.

*conceptual* · from the docs

- **Needs:** Managed Host (ch. 39)
- **Unlocks:** Fleet-up and time to ready (ch. 42)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

### Fleet-up and time to ready

The clock used for the simulation figures. It starts once every simulator pod is Ready and every simulated BMC is reachable, and it measures how long until all machines are created and every device reaches 'ready'.

*conceptual* · from the docs

- **Needs:** Machine-a-tron (ch. 16), State controller concurrency (ch. 42)
- **Docs:** [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md)

### KDF Context

The non-secret inputs that tie a derived key to one card: its MAC address and the owning host's MachineId, encoded in the versioned V1 format.

*conceptual* · from the docs

- **Needs:** Key Derivation Function (KDF) (ch. 18), Machine ID (ch. 38)
- **Unlocks:** HKDF-SHA256 (ch. 42)
- **Docs:** [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md)

### HKDF-SHA256

The standard HMAC-based KDF from RFC 5869. NICo applies it with no salt and an info string of `supernic-lock:v1:{mac}:{machine_id}` to produce each card's 8-byte lockdown key.

*conceptual* · from the docs

- **Needs:** Input Key Material (IKM) (ch. 35), KDF Context (ch. 42)
- **Docs:** [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md)

<a id="chapter-43"></a>
## Chapter 43: NIC Firmware Recovery

*Part: Host Lifecycle*

Builds on chapters 4, 5, 11, 18, 21, 25, 30, 35, 36, 39, 40, 41.

### Machine identity (JWT-SVID issuance)

A NICo feature that signs short-lived SPIFFE JWT-SVIDs for workloads on instances, through the Core gRPC API or IMDS. Each org has its own signing keys, which are encrypted under the site KEK.

*conceptual* · from the docs

- **Needs:** SPIFFE (ch. 21), Envelope encryption and KEK (ch. 18), Metadata Service (FMDS) (ch. 41), Day 0 / Day 1 / Day 2 lifecycle (ch. 5)
- **Docs:** [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md)

### Discovery data

The hardware details that nico-scout reports and NICo stores in its database, including InfiniBand devices with PCI properties and GUIDs.

*conceptual* · from the docs

- **Needs:** Scout (ch. 41)
- **Unlocks:** Machine capabilities and instance types (ch. 43)
- **Docs:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md)

### Machine capabilities and instance types

Capabilities are computed from hardware discovery and describe a machine's configurable interfaces, such as IB ports and GPUs. Instance types list the capabilities tenants can rely on, and must be a subset of the machine's capabilities.

*conceptual* · from the docs · also called Instance type and machine capabilities

- **Needs:** Discovery data (ch. 43), Instance and instance type (ch. 39)
- **Unlocks:** InstanceInfinibandConfig (ch. 44)
- **Docs:** [architecture/networking_integrations.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/networking_integrations.md), [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md)

### NIC Firmware Recovery Engine

An unreleased, disabled-by-default part of the state machine. It checks non-DPU NIC firmware against a baseline during initial preparation and deprovision, and admits and tracks firmware changes so they can be recovered safely.

*conceptual* · from the docs · also called NIC Firmware Admission, Pending check, admitted operation, NIC Firmware Recovery

- **Needs:** Managed Host Lifecycle (ch. 40), NIC Firmware Baseline Policy (ch. 36), Managed-Machine Update Scheduling Budget (ch. 39), Scout (ch. 41), SuperNIC Lockdown (ch. 25), Input Key Material (IKM) (ch. 35)
- **Unlocks:** NIC Firmware Execution Phases (ch. 43)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md), [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md)

### NIC Firmware Execution Phases

The steps an admitted operation goes through for each card: observe the supervisor, unlock, flash, then activate by reboot or card reset. It then checks a fresh inventory and restores the original lockdown policies.

*conceptual* · from the docs

- **Needs:** NIC Firmware Recovery Engine (ch. 43), Firmware Supervisor and Receipt (ch. 35), Mellanox firmware tools (mlxconfig, mst) (ch. 11)
- **Unlocks:** Tracked Dispatch (ch. 43)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Tracked Dispatch

A record (UUID token and origin) that each participating sender writes before sending a power, DPA or MLX command. An unresolved dispatch blocks further progress until the command's effects are proven settled.

*conceptual* · from the docs

- **Needs:** Recovery point and crash-window reconciliation (ch. 30), NIC Firmware Execution Phases (ch. 43)
- **Unlocks:** Operator Reconciliation (ch. 43)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Operator Reconciliation

The manual procedure used when evidence is uncertain. The operator fences all original senders, preserves the evidence, confirms that tools and hardware have settled, and then conditionally records settlement for the exact token.

*procedural* · from the docs

- **Needs:** Tracked Dispatch (ch. 43), WorkLock lease and fencing (ch. 4)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

<a id="chapter-44"></a>
## Chapter 44: Health Model

*Part: Health & Operations*

Builds on chapters 10, 30, 39, 43.

### InstanceInfinibandConfig

The tenant's InfiniBand configuration for an instance. Each interface selects a device by name, fabric and device_instance, chooses a PF or VF, and names a partition.

*procedural* · from the docs

- **Needs:** InfiniBand device (NIC port as device) (ch. 30), Machine capabilities and instance types (ch. 43), PF and VF (SR-IOV) (ch. 10)
- **Unlocks:** Device-instance to hardware mapping (ch. 44)
- **Docs:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md)

### Device-instance to hardware mapping

The rule that turns a tenant's (device, fabric, device_instance) selection into a specific hardware port: matching devices are sorted by PCI slot and the N-th is chosen.

*conceptual* · from the docs

- **Needs:** InstanceInfinibandConfig (ch. 44)
- **Docs:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md)

### HealthReport

NICo's data structure for health information. It records a source, a timestamp, and lists of successful and failed probes, each identified by a probe id and optional target. It is built to be merged across sources.

*conceptual* · from the docs · also called Health report

- **Needs:** Managed Host (ch. 39)
- **Unlocks:** Health alert classifications (ch. 44), SKU validation (ch. 45)
- **Docs:** [architecture/health_aggregation.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health_aggregation.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md), [architecture/health/health_alert_classifications.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_alert_classifications.md)

### Health alert classifications

Tags on a health alert that say how NICo reacts. For example, PreventAllocations stops tenants from receiving the host. Decisions check these tags instead of specific alert IDs.

*conceptual* · from the docs · also called Health alert classification, classification, PreventAllocations, PreventHostStateChanges

- **Needs:** HealthReport (ch. 44), Tenant instance (ch. 39)
- **Unlocks:** Health report overrides (Merge/Replace) (ch. 44), SuppressExternalAlerting (ch. 44), Leak detection (ch. 45), NVLink isolation (ch. 45), Maintenance mode (ch. 44), Aggregated host health (ch. 44), Machine validation tests (ch. 45), Targeted instance creation (ch. 46), BMC sensor thresholds (ch. 45)
- **Docs:** [architecture/health_aggregation.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health_aggregation.md), [architecture/networking_integrations.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/networking_integrations.md), [architecture/health/health_alert_classifications.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_alert_classifications.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Aggregated host health

nico-core merges the health reports from all sources into one host health. It uses this for allocation and state-transition decisions, shows it to admins, and shows a filtered version to tenants.

*conceptual* · from the docs · also called Aggregate host health

- **Needs:** Health alert classifications (ch. 44)
- **Unlocks:** Live Network Update (ch. 46)
- **Docs:** [architecture/health_aggregation.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health_aggregation.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

### Health report overrides (Merge/Replace)

An API that lets admins or external tools add health reports. Merge adds alerts alongside NICo's own, while Replace ignores built-in alerts and uses only the override.

*procedural* · from the docs · also called Merge vs Replace health reports, Merge report, Replace report, health report override

- **Needs:** Health alert classifications (ch. 44)
- **Docs:** [architecture/health_aggregation.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health_aggregation.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

### Maintenance mode

An admin marking that a host is being worked on. It applies PreventAllocations, SuppressExternalAlerting and ExcludeFromStateMachineSla.

*procedural* · from the docs

- **Needs:** Health alert classifications (ch. 44), Service-level agreement (SLA) for states (ch. 30)
- **Docs:** [architecture/health/health_alert_classifications.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_alert_classifications.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

### SuppressExternalAlerting

A classification that leaves a host out of the site-wide fleet-health calculation, so known issues do not trigger external alerts.

*conceptual* · from the docs

- **Needs:** Health alert classifications (ch. 44)
- **Docs:** [architecture/health/health_alert_classifications.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_alert_classifications.md)

<a id="chapter-45"></a>
## Chapter 45: Hardware Monitoring · Validation & Updates

*Part: Host Lifecycle*

Builds on chapters 26, 32, 41, 44.

### BMC sensor thresholds

Ranges that a sensor reports: caution, critical, fatal and valid min/max. nico-hardware-health maps them to the SensorWarning, SensorCritical, SensorFatal and SensorFailure classifications.

*conceptual* · from the docs

- **Needs:** BMC sensors and event logs (ch. 26), Health alert classifications (ch. 44)
- **Docs:** [architecture/health/health_alert_classifications.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_alert_classifications.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

### Leak detection

Health processing that turns raw leak observations (from BMC detectors, NVUE switch sensors or the BMS) into derived tray-level and rack-level leak alerts.

*conceptual* · from the docs

- **Needs:** Health alert classifications (ch. 44), BMC sensors and event logs (ch. 26), Building Management System (BMS) (ch. 26)
- **Docs:** [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md), [architecture/health/health_alert_classifications.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_alert_classifications.md)

### NVLink isolation

Removing all of a host's GPUs from every NVLink partition, triggered by the IsolateFromNvLinkPartitions classification. It is used before a compute tray is moved or replaced.

*procedural* · from the docs

- **Needs:** NVLink partition monitor (ch. 32), Health alert classifications (ch. 44)
- **Docs:** [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md), [architecture/health/health_alert_classifications.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_alert_classifications.md)

### SKU validation

A check that a host's discovered hardware (CPU, memory, GPUs, IB NICs) matches its expected SKU definition. A failure raises a SkuValidation alert.

*conceptual* · from the docs · also called SKU, SKU and BOM Validation

- **Needs:** Scout (ch. 41), HealthReport (ch. 44)
- **Docs:** [architecture/health_aggregation.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health_aggregation.md), [architecture/networking_integrations.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/networking_integrations.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### Machine validation tests

Admin-defined shell-script tests that scout runs on a host at ingestion, after cleanup, or on demand. A failure places a health alert that blocks allocation.

*conceptual* · from the docs

- **Needs:** Scout (ch. 41), Health alert classifications (ch. 44)
- **Docs:** [architecture/health_aggregation.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health_aggregation.md)

<a id="chapter-46"></a>
## Chapter 46: Tenants & Instances · DPF Custom Resources

*Part: DOCA Platform Framework*

Builds on chapters 37, 38, 39, 40, 44.

### Targeted instance creation

Creating an instance on a specific Machine ID. In some cases this can bypass health-based allocation blocks.

*procedural* · from the docs

- **Needs:** Machine ID (ch. 38), Health alert classifications (ch. 44)
- **Docs:** [architecture/health/health_alert_classifications.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_alert_classifications.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

### Live Network Update

Changing an assigned instance's networking without restarting the host. NICo keeps the old resources until every DPU acknowledges the new configuration and health is clear, then releases them in one transaction.

*conceptual* · from the docs

- **Needs:** Network Configuration Version Acknowledgement (ch. 38), Aggregated host health (ch. 44)
- **Docs:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

### DPUService CR set (Interface/Template/Configuration/NAD)

The DPF custom resources that carbide-api creates for each mandatory service. Together they define the service's chart, its configuration, its network interfaces and its network attachment.

*conceptual* · from the docs

- **Needs:** DPU Agent (ch. 38)
- **Unlocks:** DPUDeployment (ch. 46)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

### DPUDeployment

The DPF custom resource that ties together a BFB or BlueField software, a flavor and service templates for one DPU generation. NICo creates one per active deployment: BF3 always, and BF4 generic or BF4 Astra when configured.

*conceptual* · from the docs · also called BF4 Astra, Astra, Weave, Xplane

- **Needs:** DPUFlavor / DPUFlavorTemplate (ch. 37), DPUService CR set (Interface/Template/Configuration/NAD) (ch. 46)
- **Unlocks:** DPUService rollout gating (ch. 46)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md), [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md)

### DPUService rollout gating

NICo marks DPUService updates as disruptive, so each DPU is held in DPF's NodeEffect phase until it matches its DPUDeployment. The hold is then released automatically for idle Ready hosts, or by an operator with dpf service-sync release.

*conceptual* · from the docs

- **Needs:** DPF maintenance hold (NodeEffect) (ch. 37), DPUDeployment (ch. 46), Managed Host Lifecycle (ch. 40), Tenant instance (ch. 39)
- **Docs:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

<a id="chapter-47"></a>
## Chapter 47: Rack & Device States

*Part: Rack-Scale Systems*

Builds on chapters 22, 28, 29, 30, 40.

### Primary Switch

The one switch in a rack that RMS selects to host the fabric manager and telemetry cluster applications. Certificate requests for those services only target this switch.

*conceptual* · from the docs

- **Needs:** NMX-C / Fabric Manager (ch. 30), Rack Management Service (RMS) (ch. 29)
- **Unlocks:** Switch mTLS Services (ch. 48), NMX-T (ch. 49)
- **Docs:** [architecture/state_machines/switch_configure_certificate.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch_configure_certificate.md), [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md)

### Switch State Machine

The lifecycle of an NVLink switch in NICo. It runs Created → Initializing → Configuring → FetchInfo → Validating → BomValidating → Ready. From Ready the switch can enter Maintenance, ReProvisioning, Decommissioning, Error or Deleting.

*conceptual* · from the docs

- **Needs:** State machine (resource lifecycle) (ch. 30), Expected Machines Manifest (ch. 22), NVLink switch tray (ch. 28)
- **Unlocks:** Rack State Machine (ch. 47), BOM Validation (ch. 47)
- **Docs:** [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md), [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md)

### Power Shelf State Machine

The lifecycle of a power shelf in NICo. It runs Initializing → FetchingData → Configuring → Ready. Operators can trigger on-demand PowerOn/PowerOff maintenance, and the shelf can also be decommissioned or deleted.

*conceptual* · from the docs

- **Needs:** State machine (resource lifecycle) (ch. 30)
- **Unlocks:** Rack State Machine (ch. 47)
- **Docs:** [architecture/state_machines/power_shelf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/power_shelf.md), [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md)

### BOM Validation

A switch state that checks the switch against its expected Bill of Materials (the list of components it should have).

*conceptual* · from the docs · also called SKU / BOM Validation, BOM validation, SKU Validation

- **Needs:** Switch State Machine (ch. 47)
- **Docs:** [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

### Rack State Machine

The lifecycle of a rack, which is a collection of compute trays, switches and power shelves: Created → Discovering → Maintenance → Validating → Ready. It coordinates and drives the state machines of its child devices.

*conceptual* · from the docs · also called rack state handler, R_Maintenance, R_Validation

- **Needs:** Switch State Machine (ch. 47), Managed Host Lifecycle (ch. 40), Rack profile (ch. 29), Power Shelf State Machine (ch. 47)
- **Unlocks:** Rack Validation (RVS) (ch. 47), Tray Replacement / Topology Change (ch. 49), On-Demand Rack Maintenance (ch. 48), Rack Maintenance (ch. 48)
- **Docs:** [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md), [architecture/state_machines/rack.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rack.md)

### Rack Validation (RVS)

Rack validation run by the RVS service. RVS writes run-id and partition result labels on the rack's machines, and those labels move the rack's Validating sub-states forward until the rack is Validated or Failed.

*conceptual* · from the docs

- **Needs:** Rack State Machine (ch. 47)
- **Docs:** [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md)

<a id="chapter-48"></a>
## Chapter 48: Rack Maintenance

*Part: Rack-Scale Systems*

Builds on chapters 4, 10, 29, 30, 31, 35, 40, 47.

### Switch mTLS Services

A configurable list of switch services (nvue_api and the scale-up fabric telemetry, manager and telemetry interface services) that get certificate bindings. Fabric services apply only to the primary switch.

*conceptual* · from the docs

- **Needs:** Primary Switch (ch. 47), Host-Based Networking (HBN) (ch. 29)
- **Unlocks:** Switch Certificate Configuration (ch. 49)
- **Docs:** [architecture/state_machines/switch_configure_certificate.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch_configure_certificate.md)

### Submission Outcome Semantics

Error categories that say whether RMS might have received a request. RejectedBeforeDispatch is safe to retry. OperationOutcomeUnknown goes to Error rather than risk running a non-idempotent operation twice. Unsupported means the step is skipped.

*conceptual* · from the docs

- **Needs:** Idempotency (ch. 4), Asynchronous job polling (ch. 31), Rack Management Service (RMS) (ch. 29)
- **Docs:** [architecture/state_machines/switch_configure_certificate.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch_configure_certificate.md), [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md)

### On-Demand Maintenance

A maintenance operation requested by an operator, such as PowerOn, PowerOff, Reset or ReconfigureCertificate. It is stored as a request on the device record. The state controller picks it up, runs it, and clears the request when done.

*procedural* · from the docs

- **Needs:** State Controller Tick (ch. 31)
- **Docs:** [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md), [architecture/state_machines/power_shelf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/power_shelf.md), [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md)

### SOT JSON

A JSON document that defines the target firmware or system-image configuration and is passed to RMS. It comes either from the rack profile's firmware object or from an explicit maintenance activity.

*conceptual* · from the docs

- **Needs:** Rack profile (ch. 29), Firmware baseline enforcement (ch. 35)
- **Unlocks:** Maintenance Activities (ch. 48)
- **Docs:** [architecture/state_machines/rack.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rack.md)

### Maintenance Activities

The steps a maintenance run can include: firmware upgrade, NVOS update, power sequence and NMX cluster configuration. They always run in that fixed order. An empty list selects everything except the power sequence.

*conceptual* · from the docs

- **Needs:** SOT JSON (ch. 48), NVLink partitioning with NMX-C (ch. 30), NVOS / NVUE (ch. 10)
- **Unlocks:** On-Demand Rack Maintenance (ch. 48), Rack Maintenance (ch. 48)
- **Docs:** [architecture/state_machines/rack.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rack.md)

### Rack Maintenance

The rack state in which NICo runs maintenance activities in order: FirmwareUpgrade, NVOSUpdate, an optional PowerSequence reboot barrier, and ConfigureNmxCluster, then Completed. Some activities can be skipped depending on the maintenance scope.

*conceptual* · from the docs

- **Needs:** Host Reprovision (ch. 40), Rack State Machine (ch. 47), Maintenance Activities (ch. 48), Maintenance Scope (ch. 29)
- **Unlocks:** Switch ReProvisioning (ch. 49), Rack Ingestion (ch. 49), PowerSequence Reboot Barrier (ch. 48)
- **Docs:** [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md)

### On-Demand Rack Maintenance

A gRPC operation that sets a maintenance request on a rack in Ready or Error. The rack state machine then picks it up, runs the selected maintenance activities, and returns the rack through Validating to Ready.

*procedural* · from the docs

- **Needs:** Rack State Machine (ch. 47), State Controller Tick (ch. 31), Maintenance Scope (ch. 29), Maintenance Activities (ch. 48)
- **Unlocks:** Component Manager (ch. 49)
- **Docs:** [architecture/state_machines/rack.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rack.md)

### PowerSequence Reboot Barrier

A rack maintenance step that queues graceful reboots for a saved batch of compute hosts. It waits until each host reports a reboot timestamp newer than the time the batch was saved.

*conceptual* · from the docs

- **Needs:** Rack Maintenance (ch. 48)
- **Docs:** [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md)

<a id="chapter-49"></a>
## Chapter 49: GB200 Rack Hardware (part 2)

*Part: Rack-Scale Systems*

Builds on chapters 4, 10, 26, 47, 48.

### Tray Replacement / Topology Change

An external event where a compute tray is physically replaced. The old machine is deleted, a new one is discovered, and the rack goes back from Ready to Discovering.

*conceptual* · from the docs

- **Needs:** Rack State Machine (ch. 47)
- **Docs:** [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md)

### Component Manager

A pluggable layer that performs hardware operations for one class of component (compute tray, switch, power shelf) through a configured backend such as RMS or direct Redfish.

*conceptual* · from the docs · also called Component Manager (CM), CM, NvSwitchManager, UpdateComponentFirmware

- **Needs:** On-Demand Rack Maintenance (ch. 48)
- **Unlocks:** GB200 NVL72 rack-scale management (NICo Flow) (ch. 49), Switch Certificate Configuration (ch. 49)
- **Docs:** [architecture/flow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/flow.md), [architecture/backends/rms.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/backends/rms.md), [architecture/state_machines/switch_configure_certificate.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch_configure_certificate.md), [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md), [architecture/state_machines/rack.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rack.md)

### Switch Certificate Configuration

The Configuring sub-flow that first disables any existing mTLS bindings (DisableMtls) and then installs NVOS certificates (ConfigureCertificate) through asynchronous RMS jobs. Maintenance can rerun the installation step as ReconfigureCertificate.

*procedural* · from the docs

- **Needs:** Component Manager (ch. 49), Switch mTLS Services (ch. 48)
- **Docs:** [architecture/state_machines/switch_configure_certificate.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch_configure_certificate.md), [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md)

### Switch ReProvisioning

A rack-driven switch state. The switch waits in turn for the rack firmware upgrade, the NVOS upgrade and NMX-C configuration, while the rack updates status fields on the switch.

*conceptual* · from the docs

- **Needs:** Rack Maintenance (ch. 48)
- **Docs:** [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md), [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md)

### Rack Ingestion

The automatic first maintenance cycle a newly discovered rack goes through. It upgrades firmware on ready devices and admits hosts that arrive late into the same firmware job. A real NVOS update during this cycle triggers a compute reboot.

*conceptual* · from the docs

- **Needs:** Rack Maintenance (ch. 48)
- **Docs:** [architecture/state_machines/rackstatemachine.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/rackstatemachine.md)

### GB200 NVL72 rack-scale management (NICo Flow)

NICo's rack-level management for GB200 NVL72 systems. It treats racks and NVL domains as units and sequences power, firmware, leak response and power profiles across the trays in a rack.

*conceptual* · from the docs · also called NICo Flow, nico-flow, Flow, operation rule

- **Needs:** Temporal workflow engine (ch. 4), Component Manager (ch. 49)
- **Docs:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md), [architecture/flow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/flow.md)

### NMX-T

The NVLink telemetry listener service that runs on primary switches.

*conceptual* · from the docs

- **Needs:** Primary Switch (ch. 47)
- **Unlocks:** Switch reachability monitor (ch. 49)
- **Docs:** [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

### Switch reachability monitor

A nico-api task that makes a TCP connection to each ready switch's NVOS and NMX-T ports, and raises debounced unreachable alerts.

*conceptual* · from the docs

- **Needs:** Alert debouncing (ch. 26), NVOS / NVUE (ch. 10), WorkLock lease and fencing (ch. 4), NMX-T (ch. 49)
- **Docs:** [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)
