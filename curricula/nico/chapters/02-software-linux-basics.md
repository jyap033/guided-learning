# Chapter 2: Software & Linux Basics

*Part: Foundations · 6 concepts · [curriculum](../curriculum.md#chapter-2)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Chapter 1 covered the physical server (CPUs, PCIe devices, NUMA nodes) and the formats infrastructure tools use to describe it (YAML, TOML, Protocol Buffers, SQL). This chapter covers the software layer between that hardware and a system like NICo. That means the card that puts a server on the network, the programming style that lets one service talk to thousands of machines at once, the tool that tracks every change to code and config, and the Linux skills you need to inspect and limit the processes NICo runs as.

There are six lessons. You'll start with the **network interface card (NIC)**, which links Chapter 1's hardware to Chapter 3's networking. Then comes **asynchronous programming**, the style used by services that wait on many slow network calls at once. **Git** follows, since every later deployment chapter assumes your configuration lives in a repository. The last three lessons build on each other: **Linux system administration basics**, then **containers**, which are just Linux processes with extra isolation, then **memory and cgroups**, the kernel feature that lets a container runtime (and later Kubernetes) cap memory and kill a process that goes over the cap.

You need all of this because NICo is a set of long-running services deployed as containers on Kubernetes. It's configured through Git, and it manages servers whose NICs it has to discover and track. When something goes wrong (a pod is OOM-killed, a service stalls, a NIC goes missing from inventory), the concepts in this chapter are what you'll use to debug it.

The chapter ends with a build task that combines all six: an async "fleet poller" kept in Git, packaged as a container, run under a memory limit, and made to fail on purpose so you can see an OOM kill happen.

**By the end of this chapter you can:**

- Identify a server's physical NICs, their MAC addresses and PCI addresses, and tell them apart from virtual interfaces
- Write an async Python program that runs many I/O-bound tasks concurrently, and explain why a blocking call stalls it
- Use Git to commit, branch, merge and revert changes to a configuration repository
- Manage users, file permissions, packages and systemd services on a Linux machine
- Build a container image from a Dockerfile and explain how a container differs from a virtual machine
- Read a cgroup's memory limit and usage, tell resident memory from page cache, and recognise an OOM kill

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [Network interface card (NIC)](#network-interface-card)
2. [Asynchronous programming (async/await)](#asynchronous-programming)
3. [Git version control](#git-version-control)
4. [Linux system administration basics](#linux-system-administration-basics)
5. [Containers and container images](#containers-and-container-images)
6. [Linux memory and cgroups](#linux-memory-and-cgroups)
7. [Build task: A containerised async fleet poller under a memory cap](#build-task)

<a id="network-interface-card"></a>
## 1. Network interface card (NIC)

*Builds on: Server hardware basics (ch. 1)*

### Before you read

- A server has three network ports on the back, but `ip link` on it lists seven interfaces. Where might the other four come from?
- Does a MAC address belong to the operating system or to the network card?

<details>
<summary>Answers</summary>

- **A server has three network ports on the back, but `ip link` on it lists seven interfaces. Where might the other four come from?** Most are virtual interfaces that exist only in software: the loopback `lo`, bridges such as `docker0`, `veth` pairs for containers, VLAN interfaces and so on. Some physical ports can also be missing from the list. A dedicated BMC management port, for example, is wired to the BMC and never shows up in the host OS.
- **Does a MAC address belong to the operating system or to the network card?** To the card. The manufacturer assigns each port a MAC address and stores it on the NIC. The OS reads it from there, although software can override it (spoofing) and virtual interfaces get MACs made up by software.

</details>

### Explanation

A **network interface card (NIC)** is the hardware that connects a server to a network. It sends and receives Ethernet frames over a cable. On servers it is almost always a **PCIe device**: either a plug-in card or a chip on the motherboard (an *onboard* or *LOM* NIC), which still sits on the PCIe bus. That means everything from Chapter 1 applies. A NIC has a PCI address such as `0000:41:00.0`, and it is attached to one CPU socket, so it belongs to a **NUMA node**.

Key terms:

- **Port**: one physical connector. A dual-port card has two, and each usually appears to the OS as its own PCI *function* (`41:00.0`, `41:00.1`) and its own interface.
- **MAC address**: the hardware address of each port, stored on the card. Infrastructure software often uses it to recognise a machine when it boots from the network.
- **Driver**: the kernel module that operates the card, e.g. `mlx5_core` for NVIDIA/Mellanox ConnectX or `ixgbe` for Intel 10G.
- **Interface name**: what the OS calls the port. Modern Linux uses *predictable names* built from where the hardware sits. `enp65s0f1` means PCI bus 65 (decimal, i.e. `0x41`), slot 0, function 1. `eno1` means onboard device 1. The old `eth0` style is now used mostly inside VMs and containers.
- **Link speed and media**: 1, 10, 25, 100, 200 or 400 Gb/s, over copper (RJ45) or through SFP/QSFP cages that take optical transceivers or direct-attach cables.

A typical server has several network connections:

1. A **BMC management port**, wired to the baseboard management controller. The host OS can't see it.
2. One or more **data NICs** for production traffic.
3. Sometimes a **SmartNIC or DPU** (data processing unit), such as NVIDIA BlueField. This is a NIC with its own CPU cores and operating system, so it can run networking and security functions independently of the host.

Software also creates **virtual interfaces** with no hardware behind them: `lo`, bridges, `veth` pairs, VLANs and tunnels. On Linux you can tell the two kinds apart: a physical interface has a `device` link in `/sys/class/net/<name>/` that points to its PCI device, and a virtual one doesn't.

**Analogy.** A NIC is like a building's mail slot. Each slot (port) has a fixed street address (MAC), and each slot is in a particular wall (PCI slot) near a particular wing (NUMA node). The analogy breaks down because a mail slot is passive. A NIC actively runs firmware, offloads work from the CPU, and in the case of a DPU runs a whole operating system of its own. Also, unlike a street address, a MAC can be overridden in software.

### Worked example: Inventory the NICs on a Linux machine

**Step 1: List all interfaces.**

```bash
ip -br link
```
Example output:
```
lo        UNKNOWN 00:00:00:00:00:00 <LOOPBACK,UP,LOWER_UP>
enp3s0    UP      a8:a1:59:12:34:56 <BROADCAST,MULTICAST,UP,LOWER_UP>
wlp4s0    DOWN    3c:58:c2:ab:cd:ef <NO-CARRIER,BROADCAST,MULTICAST>
docker0   DOWN    02:42:7f:00:11:22 <NO-CARRIER,BROADCAST,MULTICAST,UP>
```
(On macOS, use `networksetup -listallhardwareports` instead.)

**Step 2: Separate physical from virtual.**

```bash
ls -l /sys/class/net/
```
Physical interfaces link into `/sys/devices/pci...`. Virtual ones link into `/sys/devices/virtual/net/...`. Here `enp3s0` and `wlp4s0` are physical, and `lo` and `docker0` are virtual.

**Step 3: Map the interface to its PCI device.**

```bash
readlink -f /sys/class/net/enp3s0/device
# /sys/devices/pci0000:00/0000:00:1c.0/0000:03:00.0
lspci -s 03:00.0
# 03:00.0 Ethernet controller: Intel Corporation I211 Gigabit Network Connection
```
Bus 3, slot 0, function 0 is where the name `enp3s0` comes from.

**Step 4: Read MAC, driver, speed and NUMA node.**

```bash
cat /sys/class/net/enp3s0/address        # MAC
cat /sys/class/net/enp3s0/device/numa_node  # -1 means no NUMA info (common on laptops)
sudo ethtool -i enp3s0                   # driver, firmware version, bus-info
sudo ethtool enp3s0 | grep -E 'Speed|Link detected'
```
You now have, for one port, the information an inventory system would record: name, MAC, PCI address, driver, speed and NUMA node.

### Your turn: finish it

Complete this script so it prints every interface's name, MAC address, and whether it is physical or virtual.

for dev in /sys/class/net/*; do
  name=$(basename "$dev")
  mac=$(cat "$dev/___")
  if [ -e "$dev/___" ]; then kind=physical; else kind=virtual; fi
  echo "$name $mac $kind"
done

<details>
<summary>Answer</summary>

The first blank is `address` (the file that holds the MAC) and the second is `device` (the link to the underlying PCI device, which only physical interfaces have):
```bash
mac=$(cat "$dev/address")
if [ -e "$dev/device" ]; then kind=physical; else kind=virtual; fi
```

</details>

### Your turn: on your own

`lspci` on a server shows `41:00.1 Ethernet controller: Mellanox Technologies MT2892 Family [ConnectX-6 Dx]`. Assume systemd's path-based naming scheme. (a) Which interface name would you expect for this port? (b) Which physical port of the card is it likely to be? (c) Give a command that shows which NUMA node it is attached to.

<details>
<summary>Hint 1</summary>

Interface names encode bus, slot and function, but the bus number is written in decimal, not hex.

</details>

<details>
<summary>Hint 2</summary>

0x41 = 4×16 + 1. The function number is the digit after the dot.

</details>

<details>
<summary>Hint 3</summary>

PCI devices live under `/sys/bus/pci/devices/` with the full domain prefix `0000:`.

</details>

<details>
<summary>Answer</summary>

(a) `enp65s0f1`: bus 0x41 = 65, slot 0, function 1. (b) Function 1 is usually the second port of a dual-port card (function 0 is the first). (c) `cat /sys/bus/pci/devices/0000:41:00.1/numa_node`, or `cat /sys/class/net/enp65s0f1/device/numa_node`.

</details>

### Explain it

In your own words: Why would a system that provisions bare-metal servers record each NIC's MAC address and PCI address, rather than just the interface name such as `eth0` or `enp65s0f1`?

### Check

**1. Which of these interfaces would have a `device` entry under `/sys/class/net/<name>/`?**

A. lo
B. docker0
C. enp3s0
D. veth1a2b3c

<details>
<summary>Answer</summary>

**C.** enp3s0

`device` links an interface to real hardware. `enp3s0` is a PCIe NIC port. `lo`, `docker0` (a bridge) and `veth` pairs are created by software, even though they have MACs and show up in `ip link`.

</details>

**2. A server's BMC has a dedicated management port. What does the host OS see?**

A. It appears as an extra interface in `ip link`
B. It appears only in `lspci`
C. Nothing: the port is wired to the BMC, a separate computer
D. It appears as `lo`

<details>
<summary>Answer</summary>

**C.** Nothing: the port is wired to the BMC, a separate computer

The BMC is an independent controller with its own network connection, which is how it stays reachable when the host is powered off. A dedicated BMC port isn't on the host's PCIe bus, so the host OS can't see it.

</details>

**3. What makes a DPU (such as NVIDIA BlueField) different from an ordinary NIC?**

A. It is faster
B. It has its own CPU cores and operating system and can run network functions independently of the host
C. It has no MAC address
D. It connects through USB instead of PCIe

<details>
<summary>Answer</summary>

**B.** It has its own CPU cores and operating system and can run network functions independently of the host

Speed isn't what defines a DPU, since ordinary NICs come in 400 Gb/s too. What defines it is a separate programmable computer on the card. Like other NICs, it still sits on PCIe and has MAC addresses.

</details>

**Sources:** general background knowledge; no NICo docs page covers this directly.

<a id="asynchronous-programming"></a>
## 2. Asynchronous programming (async/await)

### Before you read

- You need to query 100 servers, and each one takes 1 second to reply. Querying them one after another on a single thread takes about 100 seconds. How could a single thread finish in about 1 second?
- In an async program, what happens to the other tasks if one task calls an ordinary blocking `time.sleep(5)`?

<details>
<summary>Answers</summary>

- **You need to query 100 servers, and each one takes 1 second to reply. Querying them one after another on a single thread takes about 100 seconds. How could a single thread finish in about 1 second?** Send all 100 requests without waiting for each reply, then handle each reply as it arrives. The thread spends almost all of that second waiting, and one thread can wait on many things at once.
- **In an async program, what happens to the other tasks if one task calls an ordinary blocking `time.sleep(5)`?** They all freeze for 5 seconds. The blocking call holds the only thread, so the event loop can't switch to any other task.

</details>

### Explanation

Most infrastructure code is **I/O-bound**: it spends its time waiting on the network, disks or databases, not computing. One way to wait on many things at once is to give each task its own OS thread. But each thread costs memory (its own stack) and CPU time for switching between threads, which gets expensive with thousands of connections.

**Asynchronous programming** takes a different approach. You write functions that can *pause* while they wait, and a scheduler runs other work in the meantime. Vocabulary:

- **Coroutine / async function**: a function declared with `async def` (Python) or `async fn` (Rust). Calling it doesn't run it. It returns an object (a coroutine or *future*) that represents work still to be done.
- **`await`**: a pause point. `await something` means "I can't continue until this is ready, so run something else meanwhile."
- **Event loop / runtime**: the scheduler. It keeps a list of tasks, runs whichever are ready, and asks the OS to report when sockets or timers are ready.
- **Task**: a coroutine handed to the event loop to run concurrently with the others.

The scheduling is **cooperative**: a task gives up control only at an `await`. That has two consequences:

1. **Concurrency is not parallelism.** One thread can juggle 10,000 waiting tasks, but it still executes only one piece of Python code at any instant. CPU-heavy work doesn't get faster.
2. **Blocking calls are poison.** A non-async call that blocks (`time.sleep`, `requests.get`, a long computation) holds the thread, and every other task stalls. Use the async version (`asyncio.sleep`, an async HTTP client), or move the blocking work to a thread with `asyncio.to_thread`.

Rust services often use the **Tokio** runtime, which applies the same model across a small pool of *worker threads*. Many tasks are spread over a few threads, so you get concurrency and some parallelism. Blocking a worker thread is still a classic bug there, and you'll meet it again in Chapter 16.

**Analogy.** A single chef with ten dishes going puts a pot on to boil, chops vegetables while it heats, and checks the oven when the timer rings. One person, many dishes, because most of each dish is waiting. The analogy breaks down at two points. If the chef stops to stare at one pot for five minutes (a blocking call), every dish suffers. And if every dish needs constant chopping (CPU-bound work), juggling doesn't help: you need more chefs (threads or processes).

### Worked example: Sequential vs concurrent vs accidentally blocking

**Step 1: Write a fake I/O call.**

Save as `async_demo.py`:
```python
import asyncio, time

async def fetch(i):
    await asyncio.sleep(1)   # stands in for a 1-second network call
    return i

async def sequential():
    return [await fetch(i) for i in range(5)]

async def concurrent():
    return await asyncio.gather(*(fetch(i) for i in range(5)))

for fn in (sequential, concurrent):
    t = time.perf_counter()
    asyncio.run(fn())
    print(fn.__name__, round(time.perf_counter() - t, 2), "s")
```

**Step 2: Run it and compare.**

```bash
python3 async_demo.py
# sequential 5.01 s
# concurrent 1.0 s
```
`sequential` awaits each call before starting the next one. `gather` schedules all five as tasks, so their waits overlap.

**Step 3: Introduce a blocking bug.**

Change `fetch` to use `time.sleep(1)` instead of `await asyncio.sleep(1)` and run it again. `concurrent` now takes about 5 s too, because `time.sleep` never gives control back to the event loop.

**Step 4: Fix it without rewriting the blocking code.**

If you're stuck with a blocking library, run it on a helper thread:
```python
async def fetch(i):
    await asyncio.to_thread(time.sleep, 1)
    return i
```
`concurrent` is back to about 1 s. (`asyncio.to_thread` needs Python 3.9+.)

### Your turn: finish it

You want to poll 50 hosts, but never more than 10 at a time, so you don't overload the network. Fill in the blanks. About how long should this take?

import asyncio, time

sem = asyncio.Semaphore(10)

async def fetch(i):
    async with ___:
        await asyncio.sleep(1)
        return i

async def main():
    t = time.perf_counter()
    results = await asyncio.___(*(fetch(i) for i in range(50)))
    print(len(results), round(time.perf_counter() - t, 1))

asyncio.run(main())

<details>
<summary>Answer</summary>

`async with sem:` and `asyncio.gather(...)`. It takes about 5 seconds: 50 tasks, at most 10 running at once, 1 second each, so 5 rounds. (Creating the semaphore at module level is fine on Python 3.10+. On older versions, create it inside `main()`.)

</details>

### Your turn: on your own

Write an async program that polls 20 fake hosts. Each host takes a random 0–4 seconds (`random.uniform(0, 4)`). Any host slower than 2 seconds should be reported as `timeout` instead of making the whole program wait. Print each host's result and the total time, which should be just over 2 s.

<details>
<summary>Hint 1</summary>

asyncio has a helper that cancels an awaitable if it takes too long.

</details>

<details>
<summary>Hint 2</summary>

Look at `asyncio.wait_for(coro, timeout=...)` and the exception it raises.

</details>

<details>
<summary>Hint 3</summary>

Wrap `wait_for` in a small async function that catches `asyncio.TimeoutError` and returns `(i, "timeout")`, then `gather` 20 of those.

</details>

<details>
<summary>Answer</summary>

```python
import asyncio, random, time

async def fetch(i):
    await asyncio.sleep(random.uniform(0, 4))
    return i, "ok"

async def fetch_with_timeout(i):
    try:
        return await asyncio.wait_for(fetch(i), timeout=2)
    except asyncio.TimeoutError:
        return i, "timeout"

async def main():
    t = time.perf_counter()
    for host, status in await asyncio.gather(*(fetch_with_timeout(i) for i in range(20))):
        print(host, status)
    print(f"total {time.perf_counter() - t:.2f}s")

asyncio.run(main())
```
All timeouts run concurrently, so the total is about 2 s no matter how many hosts are slow.

</details>

### Explain it

In your own words: Why can one thread running async code handle thousands of slow network connections, yet get no faster at all when it is given four CPU-heavy hashing jobs?

### Check

**1. On one thread, you `gather` 1000 tasks that each run `await asyncio.sleep(1)`. About how long does it take?**

A. About 1 second
B. About 1000 seconds
C. About 250 seconds on a 4-core machine
D. It crashes; one thread can't hold 1000 tasks

<details>
<summary>Answer</summary>

**A.** About 1 second

All 1000 waits overlap, and the event loop just tracks 1000 timers. Core count doesn't matter here because nothing is computing. Tasks are cheap objects, not threads, so 1000 is easy.

</details>

**2. You `gather` four tasks in asyncio. Each one spends 1 second of pure CPU time computing hashes, with no awaits inside. About how long does it take?**

A. About 1 second
B. About 4 seconds
C. About 0.25 seconds

<details>
<summary>Answer</summary>

**B.** About 4 seconds

Async gives you concurrency, not parallelism. Without an `await`, a task never gives up the thread, so the four tasks run one after another. For CPU-bound work you need multiple processes or threads, and in Python's case usually processes.

</details>

**3. What does `await` actually do?**

A. Starts a new OS thread
B. Blocks the whole program until the result is ready
C. Pauses the current task and lets the event loop run other ready tasks until the result is ready
D. Makes the function run faster

<details>
<summary>Answer</summary>

**C.** Pauses the current task and lets the event loop run other ready tasks until the result is ready

`await` pauses only the current task. Blocking the whole program is what a *non*-async blocking call does. No new thread is created.

</details>

**Sources:** general background knowledge; no NICo docs page covers this directly.

<a id="git-version-control"></a>
## 3. Git version control

### Before you read

- You edit a file and save it. How is making a Git *commit* different from that save?
- Two people change the same line of the same file on different branches. What do you think happens when the branches are merged?

<details>
<summary>Answers</summary>

- **You edit a file and save it. How is making a Git *commit* different from that save?** Saving changes only the current file on disk. A commit records a permanent, labelled snapshot of the whole project (with author, time, message and a link to the previous snapshot) that you can compare against or go back to later.
- **Two people change the same line of the same file on different branches. What do you think happens when the branches are merged?** Git can't choose between them, so it reports a merge conflict, marks both versions in the file, and waits for a person to decide.

</details>

### Explanation

**Git** tracks changes to a folder of files over time. Infrastructure teams keep code *and* configuration in Git, so every change is reviewed, attributable and reversible. In Chapter 17, tools such as ArgoCD go further and deploy whatever the repository says (this is called *GitOps*).

Core terms:

- **Repository (repo)**: a project folder plus a hidden `.git` directory that holds its full history.
- **Working tree**: the files as they are on disk now, including unsaved-to-Git edits.
- **Staging area (index)**: the changes you've chosen with `git add` to go into the next commit. This lets you commit some edits and leave others.
- **Commit**: a snapshot of the staged project, identified by a hash such as `3f2a9c1`. It stores the author, the message and its *parent* commit(s), so the commits form a history graph.
- **Branch**: a movable label that points at a commit. A branch is not a copy of your files. Making a new commit moves the current branch's label forward.
- **HEAD**: which branch (or commit) you currently have checked out.
- **Merge**: combining one branch's history into another. If the target branch hasn't moved, Git just slides the label forward (a *fast-forward*). Otherwise it creates a merge commit, and if both sides changed the same lines you get a **conflict** to resolve by hand.
- **Remote**: another copy of the repo, e.g. on GitHub or GitLab. `git clone` copies it, `git push` sends your commits, and `git pull` fetches others' commits and merges them.
- **`.gitignore`**: patterns for files Git should never track, such as build outputs or secrets.

The daily loop is: edit, `git status`, `git diff`, `git add`, `git commit`. Do larger changes on a branch, then merge.

**Analogy.** Commits are like save points in a video game: you can always go back to one, and each records where you were. Branches are bookmarks on a timeline, not separate copies of the game. The analogy breaks down at merging. Games don't let you combine two playthroughs, but Git can combine two lines of history, and asks you to referee only where they disagree.

### Worked example: Commit, branch, merge, and undo a config change

**Step 1: Create a repo and the first commit.**

```bash
mkdir fleet-config && cd fleet-config
git init -b main            # -b needs Git 2.28+
git config user.name "Your Name"
git config user.email "you@example.com"
printf 'replicas: 1\nlog_level: info\n' > service.yaml
git add service.yaml
git commit -m "Add service config"
```

**Step 2: Make a change on a branch.**

```bash
git switch -c scale-up      # create and switch to a new branch
printf 'replicas: 3\nlog_level: info\n' > service.yaml
git diff                    # shows -replicas: 1 / +replicas: 3
git commit -am "Scale to 3 replicas"   # -a stages already tracked files
```

**Step 3: Merge it back.**

```bash
git switch main
git merge scale-up          # "Fast-forward": main simply moves to the new commit
git log --oneline --graph --all
```
You should see two commits, with `main` and `scale-up` both pointing at the newest one.

**Step 4: Undo safely.**

Suppose 3 replicas turns out to be a mistake:
```bash
git revert HEAD --no-edit   # new commit that reverses the last one
cat service.yaml            # replicas: 1 again
git log --oneline           # history keeps all three commits
```
`revert` adds to history instead of rewriting it, which is what you want on branches other people share.

### Your turn: finish it

You spot a typo in `service.yaml`. Fix it on its own branch and commit the fix. Fill in the blanks.

git ___ -c fix/typo
# ...edit service.yaml in your editor...
git status                 # shows service.yaml as modified
git ___ service.yaml
git commit -m "Fix typo in service config"

<details>
<summary>Answer</summary>

`git switch -c fix/typo` creates the branch and moves onto it (`git checkout -b fix/typo` is the older equivalent). `git add service.yaml` stages the change. Without it, `git commit` says there are no changes added to commit.

</details>

### Your turn: on your own

In `fleet-config`, deliberately create a merge conflict and resolve it. Branch `a` sets `log_level: debug`, `main` sets `log_level: warn`, and you want the final value to be `warn`.

<details>
<summary>Hint 1</summary>

You need two branches that start from the same commit and each change the *same line*.

</details>

<details>
<summary>Hint 2</summary>

Create branch `a` from `main` and commit `debug` there. Switch back to `main` and commit `warn`. Then run `git merge a`.

</details>

<details>
<summary>Hint 3</summary>

Git writes `<<<<<<<`, `=======` and `>>>>>>>` markers into the file. Edit the file to the version you want, delete the markers, then run `git add service.yaml` and `git commit`.

</details>

<details>
<summary>Answer</summary>

```bash
git switch -c a
printf 'replicas: 1\nlog_level: debug\n' > service.yaml && git commit -am "debug"
git switch main
printf 'replicas: 1\nlog_level: warn\n' > service.yaml && git commit -am "warn"
git merge a                 # CONFLICT (content): Merge conflict in service.yaml
# edit service.yaml so it reads exactly:
# replicas: 1
# log_level: warn
git add service.yaml
git commit --no-edit        # completes the merge commit
git log --oneline --graph   # shows two lines of history joining
```

</details>

### Explain it

In your own words: Why is it useful that a Git branch is just a pointer to a commit rather than a copy of all the files? Think about how cheap branching becomes and what merging has to work out.

### Check

**1. What is a Git branch?**

A. A full copy of the project's files in a separate folder
B. A movable pointer to a commit
C. A backup stored on the remote server
D. A list of files ignored by Git

<details>
<summary>Answer</summary>

**B.** A movable pointer to a commit

Branches are lightweight labels, which is why creating one is instant. People often picture a branch as a copy of the files because the working tree changes when you switch, but Git is just checking out a different snapshot.

</details>

**2. You edit `service.yaml` and run `git commit -m "update"` without running `git add`. What happens?**

A. The change is committed
B. Git commits an empty snapshot
C. Nothing is committed; Git reports that no changes were added to the commit
D. The edit is discarded

<details>
<summary>Answer</summary>

**C.** Nothing is committed; Git reports that no changes were added to the commit

Only staged changes go into a commit. Your edit is still safe in the working tree. `git commit -a` would stage changes to already tracked files automatically.

</details>

**3. A bad commit has already been pushed to a shared `main`. Which is the safest way to undo it?**

A. `git revert <commit>`
B. Delete the `.git` folder and start over
C. Rewrite history and force-push
D. Edit the commit's files on the remote by hand

<details>
<summary>Answer</summary>

**A.** `git revert <commit>`

`revert` adds a new commit that reverses the bad one, so everyone else's copy stays consistent. Rewriting shared history (reset plus force-push) breaks other people's clones and is usually blocked on protected branches.

</details>

**Sources:** general background knowledge; no NICo docs page covers this directly.

<a id="linux-system-administration-basics"></a>
## 4. Linux system administration basics

### Before you read

- On a Linux server, where would you look for a service's system-wide configuration file, and where for its logs?
- What do you think the permission string `-rw-r-----` means?

<details>
<summary>Answers</summary>

- **On a Linux server, where would you look for a service's system-wide configuration file, and where for its logs?** Configuration usually lives under `/etc`. Logs are in the systemd journal (`journalctl -u <service>`) and sometimes in files under `/var/log`.
- **What do you think the permission string `-rw-r-----` means?** It's a regular file. The owner can read and write it, members of its group can only read it, and everyone else has no access. In numeric form that's `640`.

</details>

### Explanation

Almost every server NICo manages, and every container it runs in, is Linux. These are the basics you need.

**Distributions and packages.** A *distribution* (Ubuntu, Debian, RHEL, Fedora) is the Linux kernel plus a set of software and a **package manager** that installs it: `apt` on Debian/Ubuntu, `dnf` on Fedora/RHEL. `sudo apt-get install -y curl` downloads curl along with anything it depends on.

**Users and groups.** Every process runs as a user, identified by a numeric **UID**. `root` (UID 0) can do anything. Normal users can't, and they use `sudo` to run single commands as root. Groups let several users share access. `id` shows who you are.

**Files and permissions.** Each file has an owner, a group, and three sets of `r`/`w`/`x` (read, write, execute) permissions: for the owner, the group and everyone else. `chmod 640 file` sets them and `chown user:group file` changes ownership. A script won't run unless it has `x` set.

**Filesystem layout.** `/etc` holds config, `/var` holds changing data (logs, databases), `/home` holds users' files, `/usr` holds installed programs, and `/tmp` is scratch space. `/proc` and `/sys` aren't on disk at all. They are windows into the kernel: `/proc/<pid>/` describes each process, and `/sys/class/net/` lists network interfaces, as you saw in the NIC lesson.

**Processes and signals.** Each running program has a **PID**. `ps aux` and `top` list processes. `kill <pid>` sends SIGTERM (a polite request to exit), and `kill -9` sends SIGKILL, which can't be caught or ignored.

**Services.** Long-running background programs (daemons) are managed by **systemd**. Each is described by a *unit file*. `systemctl start/stop/restart <svc>` controls it now, `systemctl enable <svc>` makes it start at boot, `systemctl status <svc>` shows its state, and `journalctl -u <svc>` shows its logs.

**Analogy.** A Linux server is like an office building. Users are staff with ID badges, permissions are which doors each badge opens, `/etc` is the policy binder, `/var/log` is the security desk's logbook, and systemd is the facilities manager who makes sure the lifts and lights start every morning and get restarted when they break. The analogy breaks down with `/proc` and `/sys`: no office has filing cabinets whose contents are generated live from what's happening at that moment.

### Worked example: Users, permissions, packages, then a service

**Step 1: Get a disposable Linux shell.**

On any machine with Docker or Podman:
```bash
docker run --rm -it ubuntu:24.04 bash
```
You are root inside a throwaway Ubuntu. (Containers are covered in the next lesson. For now, treat this as a scratch Linux box. It has no systemd, so do step 5 on a real Linux machine or VM.)

**Step 2: Install packages.**

```bash
apt-get update
apt-get install -y procps less
ps aux          # provided by procps
```

**Step 3: Create users and check identity.**

```bash
useradd -m -s /bin/bash alice
useradd -m -s /bin/bash bob
id alice       # uid=1001(alice) gid=1001(alice) groups=1001(alice)
```
(The exact numbers may differ.)

**Step 4: Control access with permissions.**

```bash
echo 'db_password=hunter2' > /etc/demo.conf
chown root:alice /etc/demo.conf
chmod 640 /etc/demo.conf
ls -l /etc/demo.conf                  # -rw-r----- 1 root alice ...
su alice -c 'cat /etc/demo.conf'      # works: alice is in group alice
su bob -c 'cat /etc/demo.conf'        # cat: /etc/demo.conf: Permission denied
```

**Step 5: Run a service with systemd (real Linux host or VM).**

Create `/etc/systemd/system/hello.service`:
```ini
[Unit]
Description=Hello loop

[Service]
ExecStart=/bin/sh -c 'while true; do echo hello; sleep 5; done'
User=nobody
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
Then:
```bash
sudo systemctl daemon-reload          # re-read unit files
sudo systemctl enable --now hello     # start now and at every boot
systemctl status hello
journalctl -u hello -f                # watch "hello" every 5 s; Ctrl-C to stop
sudo systemctl disable --now hello    # clean up
```

### Your turn: finish it

You've just edited `/etc/systemd/system/hello.service` to change its `ExecStart`. Fill in the blanks so the change takes effect and you can see the new log output.

sudo systemctl ___
sudo systemctl restart hello
journalctl ___ hello -n 20

<details>
<summary>Answer</summary>

`sudo systemctl daemon-reload` makes systemd re-read changed unit files. Without it, restart uses the old definition. `journalctl -u hello -n 20` shows the last 20 log lines for that unit.

</details>

### Your turn: on your own

A colleague's unit file has `ExecStart=/opt/app/run.sh` and `User=appuser`. `systemctl status app` shows it failing, and `journalctl -u app` says `Permission denied`. List what you would check, in order, and the command for each.

<details>
<summary>Hint 1</summary>

"Permission denied" on start means the user can't read or execute something.

</details>

<details>
<summary>Hint 2</summary>

Look at the script's permission bits and owner with `ls -l`. Is `x` set? Can `appuser` reach it?

</details>

<details>
<summary>Hint 3</summary>

Check `ls -l /opt/app/run.sh` (needs `x`, fix with `chmod +x`), and that `appuser` can traverse `/opt` and `/opt/app` (`ls -ld`). Then test with `sudo -u appuser /opt/app/run.sh`.

</details>

<details>
<summary>Answer</summary>

1. `ls -l /opt/app/run.sh`: if there's no `x` for the relevant class (owner/group/other), run `sudo chmod 755 /opt/app/run.sh` or `chmod +x`. 2. `ls -ld /opt /opt/app`: each directory needs `x` for appuser, or it can't reach the file. 3. Reproduce as the service user: `sudo -u appuser /opt/app/run.sh`. 4. If the script itself opens files, check those the same way. 5. After fixing, run `sudo systemctl restart app` and `journalctl -u app -n 20`. (Run `daemon-reload` only if you edited the unit file.)

</details>

### Explain it

In your own words: Why do services usually run as a dedicated non-root user (such as `User=nobody` or `User=appuser`) instead of as root, even though root would never hit "Permission denied"?

### Check

**1. After `chmod 640 secrets.conf`, owned by `root:ops`, who can read the file?**

A. Only root
B. root and members of group ops
C. Everyone
D. root, group ops, and anyone who knows the path

<details>
<summary>Answer</summary>

**B.** root and members of group ops

6 = rw for the owner, 4 = r for the group, 0 = nothing for others. Knowing the path grants nothing: permissions are checked on every access.

</details>

**2. What is `/proc`?**

A. A folder of installed programs
B. A virtual filesystem the kernel generates to expose running processes and system state
C. A backup of `/etc`
D. The swap partition

<details>
<summary>Answer</summary>

**B.** A virtual filesystem the kernel generates to expose running processes and system state

Nothing in `/proc` (or `/sys`) is stored on disk. Reading a file there asks the kernel for live data. Installed programs live in `/usr`.

</details>

**3. What does `systemctl enable hello` do on its own?**

A. Starts the service immediately
B. Configures the service to start at boot, without necessarily starting it now
C. Reloads unit files
D. Shows the service's logs

<details>
<summary>Answer</summary>

**B.** Configures the service to start at boot, without necessarily starting it now

`enable` is about boot and `start` is about now. `enable --now` does both. People often expect `enable` to start the service too.

</details>

**Sources:** general background knowledge; no NICo docs page covers this directly.

<a id="containers-and-container-images"></a>
## 5. Containers and container images

*Builds on: Linux system administration basics (ch. 2)*

### Before you read

- Is a container a small virtual machine with its own kernel?
- You build an image on an Apple Silicon (arm64) Mac and run it on an amd64 server. What do you expect to happen?

<details>
<summary>Answers</summary>

- **Is a container a small virtual machine with its own kernel?** No. A container is an ordinary process on the host, sharing the host's kernel. The kernel gives it a private view of the filesystem, network and process list (namespaces) and caps its resources (cgroups).
- **You build an image on an Apple Silicon (arm64) Mac and run it on an amd64 server. What do you expect to happen?** Unless the image was built for amd64 too (multi-arch) or the server emulates arm64, it fails, typically with `exec format error`. Images contain compiled binaries for one CPU architecture.

</details>

### Explanation

Shipping software to servers used to mean "install the right packages, at the right versions, in the right places," and that varied from machine to machine. Containers solve this by shipping the application *together with its filesystem*.

**Container image**: a read-only package made of stacked **layers**. Each layer is a set of filesystem changes. The image also carries metadata saying which command to run, environment variables and so on. Images follow the **OCI** standard, so Docker, Podman, containerd and Kubernetes can all use the same images.

**Container**: a running process (or group of processes) started from an image. The runtime adds a thin *writable layer* on top of the image's layers, and the kernel isolates the process with:

- **Namespaces**: private views of the system. In a PID namespace the process sees itself as PID 1. In a network namespace it gets its own interfaces (usually `lo` and a virtual `eth0`, which is a `veth`). It also gets its own mount table and its own hostname.
- **cgroups**: limits on CPU and memory, covered in the next lesson.

There's no separate kernel, which is why containers start in milliseconds. It's also why an arm64 image can't run natively on amd64: the binaries inside must match the host CPU.

**Dockerfile**: the recipe for an image. Common instructions: `FROM` (the base image), `RUN` (run a command at build time, producing a layer), `COPY` (add files from your machine), `WORKDIR`, `ENV`, and `CMD`/`ENTRYPOINT` (what to run at start). The builder **caches** layers: if an instruction and everything before it haven't changed, the cached layer is reused. Put rarely changing steps (dependency installs) before frequently changing ones (your code).

**Tags and registries**: images are named like `registry/repo:tag`, e.g. `docker.io/library/python:3.12-slim`, and stored in **registries** you push to and pull from. A tag can be moved to point at a new image. A **digest** (`@sha256:...`) always identifies exactly one image.

The writable layer is thrown away when the container is removed. Keep data you care about in **volumes**.

**Analogy.** An image is like a sealed meal kit: the recipe card plus every ingredient, packed in layers. A container is someone cooking that kit in a shared kitchen (the host kernel) at their own walled-off station. The analogy breaks down because a real kitchen station wouldn't let a cook believe they were the only cook in the building, and namespaces do exactly that.

### Worked example: Build an image and look at the container from both sides

**Step 1: Write a tiny app and Dockerfile.**

In an empty folder, create `app.py`:
```python
import os, socket
print("hostname:", socket.gethostname())
print("my pid:", os.getpid())
print("interfaces:", sorted(os.listdir("/sys/class/net")))
```
and `Dockerfile`:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY app.py .
CMD ["python", "app.py"]
```

**Step 2: Build and run.**

```bash
docker build -t hello-ctr:0.1 .
docker run --rm hello-ctr:0.1
# hostname: 4c1d2e3f5a6b     <- the container ID, not your machine's name
# my pid: 1                 <- PID namespace
# interfaces: ['eth0', 'lo'] <- network namespace (eth0 is a veth)
```
(Podman users: replace `docker` with `podman` throughout.)

**Step 3: Inspect layers and architecture.**

```bash
docker history hello-ctr:0.1        # one row per layer; your COPY is near the top
docker image inspect --format '{{.Architecture}}' hello-ctr:0.1   # amd64 or arm64
```

**Step 4: See that it's just a host process (Linux hosts).**

```bash
docker run -d --name sleeper hello-ctr:0.1 python -c "import time; time.sleep(300)"
ps aux | grep 'time.sleep'          # visible on the host with an ordinary PID
docker rm -f sleeper
```
On macOS, Docker runs containers inside a hidden Linux VM, so the process lives there and not in your Mac's `ps`.

### Your turn: finish it

This app has dependencies in `requirements.txt`. Fill in the blanks so that changing only `app.py` reuses the cached dependency layer and doesn't reinstall everything.

FROM python:3.12-slim
WORKDIR /app
COPY ___ .
RUN pip install --no-cache-dir -r requirements.txt
COPY ___ .
CMD ["python", "app.py"]

<details>
<summary>Answer</summary>

First `COPY requirements.txt .`, then after the install `COPY app.py .`. The `pip install` layer depends only on `requirements.txt`, so editing `app.py` invalidates just the last `COPY` and everything after it. If you copied everything (`COPY . .`) before `pip install`, any code change would trigger a full reinstall.

</details>

### Your turn: on your own

Show that files written inside a container disappear when it's removed, then use a named volume so a file survives across two separate `docker run --rm` invocations.

<details>
<summary>Hint 1</summary>

Write a file in one `--rm` container, then try to read it from a second one.

</details>

<details>
<summary>Hint 2</summary>

`-v NAME:/path` mounts a named volume, which Docker creates if it doesn't exist.

</details>

<details>
<summary>Hint 3</summary>

`docker run --rm -v demo-data:/data ubuntu:24.04 sh -c 'echo hi > /data/f'`, then read `/data/f` from another container with the same `-v`.

</details>

<details>
<summary>Answer</summary>

```bash
docker run --rm ubuntu:24.04 sh -c 'echo hi > /tmp/f'
docker run --rm ubuntu:24.04 cat /tmp/f          # No such file: new writable layer

docker run --rm -v demo-data:/data ubuntu:24.04 sh -c 'echo hi > /data/f'
docker run --rm -v demo-data:/data ubuntu:24.04 cat /data/f   # hi
docker volume rm demo-data                          # clean up
```

</details>

### Explain it

In your own words: Why does a container start in well under a second while a virtual machine takes much longer, and what does that same design choice cost you (think about kernels and CPU architectures)?

### Check

**1. How does a container differ from a virtual machine?**

A. A container runs its own kernel on emulated hardware
B. A container is a host process that shares the host kernel, isolated by namespaces and limited by cgroups
C. A container is the same as a VM but smaller
D. A container can only run Python

<details>
<summary>Answer</summary>

**B.** A container is a host process that shares the host kernel, isolated by namespaces and limited by cgroups

VMs emulate hardware and boot their own kernel. Containers don't, which is why they're fast but have to match the host's kernel and CPU architecture.

</details>

**2. A container writes logs to `/var/log/app.log` inside itself (no volume). You run `docker rm` on it. What happens to the logs?**

A. They are saved back into the image
B. They move to the host's `/var/log`
C. They are deleted along with the container's writable layer
D. They stay until the next reboot

<details>
<summary>Answer</summary>

**C.** They are deleted along with the container's writable layer

Images are read-only, and container writes go to a per-container layer that is removed with the container. Use volumes, or log to stdout so the runtime collects the output.

</details>

**3. You change one line in `app.py`. The Dockerfile copies `app.py` *before* a slow `RUN pip install`. What happens on rebuild?**

A. Only the COPY layer is rebuilt
B. The COPY layer and every later layer, including pip install, are rebuilt
C. Nothing; Docker ignores code changes
D. The base image is re-downloaded

<details>
<summary>Answer</summary>

**B.** The COPY layer and every later layer, including pip install, are rebuilt

The cache stops at the first changed instruction, and everything after it reruns. That's why dependency installs go before copying code.

</details>

**Sources:** general background knowledge; no NICo docs page covers this directly.

<a id="linux-memory-and-cgroups"></a>
## 6. Linux memory and cgroups

*Builds on: Linux system administration basics (ch. 2)*

### Before you read

- `free -h` on a 16 GiB server shows only 300 MiB "free", yet the machine runs fine. Why?
- A container is limited to 100 MiB and its program tries to use 200 MiB. What do you think happens?

<details>
<summary>Answers</summary>

- **`free -h` on a 16 GiB server shows only 300 MiB "free", yet the machine runs fine. Why?** Linux uses spare RAM as page cache, keeping recently read or written file data in memory. That cache can be given back almost instantly, so the `available` column (free plus reclaimable cache) is the number that matters.
- **A container is limited to 100 MiB and its program tries to use 200 MiB. What do you think happens?** The kernel first reclaims what it can, such as the container's page cache. If that isn't enough, the OOM (out-of-memory) killer sends SIGKILL to a process in that container, which usually exits with code 137 (128 + signal 9).

</details>

### Explanation

**How Linux counts memory.** Each process gets a large *virtual* address space, but RAM is only used for pages the process has actually touched. Two numbers matter:

- **VSZ** (virtual size): everything the process has mapped, including memory it reserved but never used. Often huge and rarely meaningful.
- **RSS** (resident set size): the pages actually in RAM right now. You'll find it as `VmRSS` in `/proc/<pid>/status` and in the RSS column of `ps aux`.

Memory also comes in two kinds:

- **Anonymous** memory: heap, stacks, Python objects. It has no file behind it, so the kernel can't drop it (it can only swap it out, if swap exists).
- **File-backed** memory, mostly the **page cache**: copies of file data kept in RAM to speed up reads and writes. The kernel can drop clean cache pages whenever it needs room. `free` shows this as `buff/cache`, and `available` estimates what you could use without swapping.

**cgroups (control groups)** are a kernel feature that puts processes into a hierarchy of groups and accounts for and limits each group's resources: memory, CPU, I/O and number of processes. Modern systems use **cgroup v2**, mounted at `/sys/fs/cgroup`. Each group is a directory of control files:

- `memory.max`: the hard limit in bytes (or `max` for unlimited)
- `memory.current`: current usage, *including page cache charged to the group*
- `memory.stat`: a breakdown (`anon`, `file`, `active_file`, `inactive_file`, ...)
- `memory.events`: counters such as `oom_kill`

When a group reaches `memory.max`, the kernel reclaims the group's page cache first. If that still isn't enough, it invokes the **OOM killer** inside that group: one process gets SIGKILL and exits with code **137**.

`docker run --memory=100m` simply writes `104857600` to the container's `memory.max`. Two things catch people out. First, `free` and `/proc/meminfo` inside a container show the **host's** memory, not the limit. Second, because page cache counts toward `memory.current`, usage can look far higher than the program's RSS. Chapter 16 explains how Kubernetes handles this with its "working set" metric.

**Analogy.** A cgroup is like a prepaid budget for a team. All of the team's spending counts against it, including the reusable stuff in their stockroom (page cache). When the budget runs out, the accountant first clears the stockroom, and only if that isn't enough does someone get fired (OOM-killed). The analogy breaks down because a real accountant would ask first. SIGKILL can't be caught, so the process gets no chance to clean up.

### Worked example: Watch page cache, anonymous memory and an OOM kill inside a limited container

**Step 1: Start a container with a hard 100 MiB limit.**

```bash
docker run --rm -it --memory=100m --memory-swap=100m python:3.12-slim bash
```
Setting `--memory-swap` equal to `--memory` means "no extra swap", so the result is predictable.

**Step 2: Find the limit (and the misleading number).**

```bash
cat /proc/self/cgroup              # 0::/   -> cgroup v2, you're at the container's cgroup root
cat /sys/fs/cgroup/memory.max      # 104857600 (= 100 MiB)
head -1 /proc/meminfo              # MemTotal: the HOST's RAM, not 100 MiB
```

**Step 3: Generate page cache and see it charged.**

```bash
grep -E '^(anon|file) ' /sys/fs/cgroup/memory.stat
dd if=/dev/zero of=/tmp/big bs=1M count=50
grep -E '^(anon|file) ' /sys/fs/cgroup/memory.stat   # 'file' grows by roughly 50 MiB
cat /sys/fs/cgroup/memory.current
```
No program is holding 50 MiB, but the group is charged for the cached file data.

**Step 4: Use anonymous memory under the limit.**

```bash
python3 -c "x = b'x' * (60*1024*1024); print(open('/sys/fs/cgroup/memory.current').read())"
```
This succeeds. Cache plus 60 MiB would exceed 100 MiB, so the kernel reclaims page cache to make room.

**Step 5: Exceed the limit and confirm the OOM kill.**

```bash
python3 -c "x = b'x' * (150*1024*1024)"
# Killed
echo $?                               # 137 = 128 + 9 (SIGKILL)
grep oom_kill /sys/fs/cgroup/memory.events   # oom_kill 1
```
Anonymous memory can't be reclaimed and there's no swap, so the kernel killed the biggest process in the group. Your `bash` survived.

### Your turn: finish it

Inside a memory-limited container, print how much of the limit is in use as a percentage. Fill in the two filenames.

cur=$(cat /sys/fs/cgroup/___)
max=$(cat /sys/fs/cgroup/___)
echo "$(( cur * 100 / max ))% of limit"

<details>
<summary>Answer</summary>

`memory.current` and `memory.max`. If the container has no limit, `memory.max` contains the word `max` and the arithmetic fails, so a robust script checks for that first.

</details>

### Your turn: on your own

On a Linux host (not inside a container), find the cgroup your current shell belongs to and print that cgroup's memory usage.

<details>
<summary>Hint 1</summary>

Every process's cgroup membership is listed in a file under `/proc`.

</details>

<details>
<summary>Hint 2</summary>

`/proc/self/cgroup` on cgroup v2 has one line like `0::/some/path`. That path is relative to `/sys/fs/cgroup`.

</details>

<details>
<summary>Hint 3</summary>

Take the part after `0::`, prepend `/sys/fs/cgroup`, and read `memory.current` in that directory.

</details>

<details>
<summary>Answer</summary>

```bash
cat /proc/self/cgroup
# 0::/user.slice/user-1000.slice/session-2.scope   (example)
cg=$(cut -d: -f3 /proc/self/cgroup)
cat /sys/fs/cgroup${cg}/memory.current
```
`systemd-cgls` shows the whole tree. If `/sys/fs/cgroup/memory.current` doesn't exist anywhere, the host is probably on the older cgroup v1, where the equivalent file is `memory/.../memory.usage_in_bytes`.

</details>

### Explain it

In your own words: Why can a container's `memory.current` be much higher than the RSS of every process inside it, and why doesn't that alone mean it's about to be OOM-killed?

### Check

**1. A container limited to 512 MiB runs `free -m` and sees 32,000 MiB total. Why?**

A. The limit didn't apply
B. `free` reads `/proc/meminfo`, which reports the host's memory; the limit lives in the cgroup's `memory.max`
C. The container has its own kernel with more RAM
D. Swap is counted as RAM

<details>
<summary>Answer</summary>

**B.** `free` reads `/proc/meminfo`, which reports the host's memory; the limit lives in the cgroup's `memory.max`

Namespaces don't virtualise `/proc/meminfo`, so the limit is enforced but `free` can't see it. To check the real limit, read `/sys/fs/cgroup/memory.max`. Containers share the host kernel, so the "own kernel" answer is wrong.

</details>

**2. A container process exits with code 137 and `memory.events` shows `oom_kill 1`. What happened?**

A. The program called `exit(137)`
B. It received SIGTERM and shut down cleanly
C. The kernel's OOM killer sent SIGKILL because the cgroup hit its memory limit
D. The disk was full

<details>
<summary>Answer</summary>

**C.** The kernel's OOM killer sent SIGKILL because the cgroup hit its memory limit

Exit codes above 128 mean the process died from a signal (code minus 128), and 137 − 128 = 9 = SIGKILL. SIGTERM would give 143. The `oom_kill` counter confirms it was the OOM killer.

</details>

**3. Which kind of memory can the kernel reclaim quickly when a cgroup nears its limit, without swap?**

A. Anonymous memory such as the Python heap
B. Clean page cache
C. Kernel stacks
D. None; usage only goes up until an OOM kill

<details>
<summary>Answer</summary>

**B.** Clean page cache

Clean cached file pages are copies of data already on disk, so the kernel can just drop them. Anonymous memory has nowhere to go without swap, which is why it's what triggers OOM kills.

</details>

**Sources:** general background knowledge; no NICo docs page covers this directly.

<a id="build-task"></a>
## Build task: A containerised async fleet poller under a memory cap

**Goal:** Build a small Python service that polls 200 simulated hosts concurrently with asyncio and reports the NICs and cgroup memory limit it can see. Keep it in a Git repository, package it as a container image, run it under a memory limit, then add a feature on a branch that makes it get OOM-killed on purpose.

**Why it matters for NICo:** NICo's services work the same way: long-running async programs that talk to many machines, configured through Git, shipped as container images, and run with memory limits enforced by cgroups. Seeing from both sides what a container can see (virtual NICs, host memory totals, its own cgroup) and what an OOM kill looks like gives you a baseline for debugging real deployments in later chapters.

**You need:**

- Linux or macOS with a terminal
- Git 2.28+ (`git --version`)
- Docker (Docker Desktop on macOS) or Podman. Replace `docker` with `podman` if you use Podman.
- Optional: Python 3.10+ to run the script outside a container
- A text editor

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Create the repository</summary>

```bash
mkdir fleet-poller && cd fleet-poller
git init -b main
git config user.name "Your Name"
git config user.email "you@example.com"
```

</details>

<details>
<summary>Step 2: Write the async poller</summary>

Create `poller.py`:
```python
import asyncio, random, sys, time
from pathlib import Path

async def poll(host_id):
    await asyncio.sleep(random.uniform(0.5, 1.0))   # pretend network I/O
    return host_id, "ok"

def nics():
    base = Path("/sys/class/net")
    if not base.exists():          # e.g. running directly on macOS
        return []
    out = []
    for p in sorted(base.iterdir()):
        mac = (p / "address").read_text().strip()
        kind = "physical" if (p / "device").exists() else "virtual"
        out.append((p.name, mac, kind))
    return out

def cgroup_mem():
    def read(name):
        f = Path("/sys/fs/cgroup") / name
        return f.read_text().strip() if f.exists() else "n/a"
    return read("memory.max"), read("memory.current")

async def main(n=200):
    start = time.perf_counter()
    results = await asyncio.gather(*(poll(i) for i in range(n)))
    elapsed = time.perf_counter() - start
    ok = sum(1 for _, status in results if status == "ok")
    print(f"polled {ok}/{n} hosts in {elapsed:.2f}s")
    for name, mac, kind in nics():
        print(f"nic {name:<12} {mac}  {kind}")
    mx, cur = cgroup_mem()
    print(f"cgroup memory.max={mx} memory.current={cur}")

if __name__ == "__main__":
    asyncio.run(main())
```
If you have Python, run `python3 poller.py` once. On a Linux laptop, your real NIC(s) should show as `physical`.

</details>

<details>
<summary>Step 3: Commit the first version</summary>

```bash
git add poller.py
git commit -m "Add async fleet poller"
```

</details>

<details>
<summary>Step 4: Containerise it and run under a limit</summary>

Create `Dockerfile`:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY poller.py .
CMD ["python", "poller.py"]
```
Build, run and commit:
```bash
docker build -t fleet-poller:0.1 .
docker run --rm --memory=64m --memory-swap=64m fleet-poller:0.1
git add Dockerfile && git commit -m "Add Dockerfile"
```
Expected: `polled 200/200 hosts in ~1.0s`, `lo` and `eth0` both listed as `virtual`, and `memory.max=67108864`.

</details>

<details>
<summary>Step 5: Add a memory-hog mode on a branch</summary>

```bash
git switch -c feature/hog
```
Add this function above the `if __name__ ...` block:
```python
def hog():
    chunks = []
    while True:
        chunks.append(b"x" * (10 * 1024 * 1024))   # 10 MiB of touched, anonymous memory
        print(f"holding {len(chunks) * 10} MiB, memory.current={cgroup_mem()[1]}", flush=True)
```
and change the entry point to:
```python
if __name__ == "__main__":
    if "--hog" in sys.argv:
        hog()
    else:
        asyncio.run(main())
```
Commit it, then merge back:
```bash
git commit -am "Add --hog mode to demonstrate OOM kills"
git switch main
git merge feature/hog
```
**Only ever run `--hog` with `--memory` set.** Without a limit it will eat your laptop's RAM.

</details>

<details>
<summary>Step 6: Trigger and confirm the OOM kill</summary>

```bash
docker build -t fleet-poller:0.2 .
docker run --name hog --memory=64m --memory-swap=64m fleet-poller:0.2 python poller.py --hog
# holding 10 MiB ... holding 50 MiB ... then output stops
docker inspect -f '{{.State.OOMKilled}} {{.State.ExitCode}}' hog
docker rm hog
```
There's no `--rm` here, so the stopped container is kept for inspection.

</details>

<details>
<summary>Step 7: Tag the release in Git</summary>

```bash
git tag v0.2
git log --oneline --graph --all
```

</details>

**Check it works:** All of the following hold: (1) `docker run --rm --memory=64m --memory-swap=64m fleet-poller:0.2` prints `polled 200/200 hosts in` a time under about 1.5s, NICs marked `virtual`, and `memory.max=67108864`. (2) `docker inspect -f '{{.State.OOMKilled}} {{.State.ExitCode}}' hog` (run before `docker rm hog`) prints `true 137`. (3) `git log --oneline` shows at least three commits, including "Add --hog mode", and `git tag` lists `v0.2`.

<details>
<summary>If you get stuck</summary>

- `memory.max=n/a` inside the container: the host is probably on cgroup v1, the old layout. Check with `stat -fc %T /sys/fs/cgroup` on the host (`cgroup2fs` means v2). Docker Desktop on macOS uses v2.
- Rootless Podman errors about memory limits usually mean the memory controller isn't delegated to your user, or the host is on cgroup v1. Try `docker`, rootful Podman, or a recent distro with cgroup v2.
- Polling takes about 150 s instead of about 1 s: you probably used `time.sleep` instead of `await asyncio.sleep`, or awaited each `poll` in a loop instead of using `gather`.
- `OOMKilled` shows `false` but the exit code is 137: something else sent SIGKILL. Make sure you didn't run `docker stop`/`kill`, and that `--memory` was actually applied (`docker inspect -f '{{.HostConfig.Memory}}' hog`).
- `exec format error` when moving the image to another machine: you built for a different CPU architecture (see the containers lesson). Rebuild on the target machine for now. Multi-arch builds come in Chapter 13.

</details>

**Stretch goal:** Add an `asyncio.Semaphore` so at most 20 hosts are polled at once, and predict the new runtime before you measure it. It should be roughly 200 × 0.75 s ÷ 20 ≈ 7.5 s. Then add a `--slow` flag that makes 10% of hosts take 5 s, wrap each poll in `asyncio.wait_for(..., timeout=2)`, and report timeouts. Finally, change `poll` to call `time.sleep` instead and explain the measured slowdown with what you learned about the event loop.

## Review notes

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (Network interface card (NIC)): Independent problem answer (a) gives `enp65s0f1` for a ConnectX-6 Dx port. On current systemd with mlx5_core, Mellanox ports usually get a phys_port_name suffix (e.g. `enp65s0f1np1`), so a learner checking real hardware will see a name that doesn't match the answer. *Fix:* Add a note to the answer: with mlx5 the kernel often adds a port suffix, so the actual name may be `enp65s0f1np1`. The bus/slot/function part is still derived as shown.
- **minor** (Network interface card (NIC)): The claim that `eth0`-style names are 'now used mostly inside VMs and containers' is inaccurate for VMs. Many KVM and cloud VMs use predictable names such as `ens3`, `ens4`, `ens5` or `enp1s0`. *Fix:* Say the old `eth0` style is now seen mainly inside containers and on some VMs or systems where predictable naming is turned off.
- **minor** (Network interface card (NIC)): The explanation and the BMC check say the host can't see the BMC at all. The dedicated port is invisible, but the BMC itself often appears in `lspci` (e.g. an ASPEED VGA controller) and many BMCs give the host a USB network interface (Redfish host interface). This makes the 'only in lspci' option look plausible to a careful learner. *Fix:* Make clear that the host can't see the dedicated management port as one of its network interfaces, while noting that the BMC may still show up as other devices. Alternatively, reword the check to ask specifically about the host's network interfaces in `ip link`.

---

[← 01-hardware-basics-data-formats.md](01-hardware-basics-data-formats.md) · [03-networking-basics.md →](03-networking-basics.md)
