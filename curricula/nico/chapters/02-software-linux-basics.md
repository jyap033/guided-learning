# Chapter 2: Software & Linux Basics

*Part: Foundations · 6 concepts · [curriculum](../curriculum.md#chapter-2)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Chapter 1 covered the physical server: CPUs, NUMA nodes, PCIe devices and their addresses, MAC addresses. This chapter covers the software layer that runs on that hardware and the tools you will use every day while working with NICo.

There are six lessons. The first is the **network interface card**, the hardware that NICo's networking features configure. The second is **asynchronous programming**, the style used by services that handle thousands of slow network calls at once. The third is **Git**, which you will use to track every config change and later to drive GitOps deployments. The last three work down the Linux stack: **basic system administration** (users, permissions, packages, services), **containers** (how applications get packaged and isolated), and **memory and cgroups** (how Linux counts memory and how a container gets capped or OOM-killed).

Why this matters for NICo: NICo provisions bare-metal machines, so you need to know what a NIC is and how Linux shows it to you. NICo itself runs as containerised services on Kubernetes (chapter 14). It is deployed through Git-driven workflows (chapter 17), and in chapter 16 you will tune its async runtime and its memory limits. When something goes wrong in those later chapters, the skills from this chapter are how you find out why.

Everything here runs on a normal laptop. You need a terminal, Python 3, Git and Docker or Podman. The chapter ends with a build that combines all six lessons: you write a small async "inventory agent" in a Git repo, package it as a container, and run it under a memory limit.

**By the end of this chapter you can:**

- Identify a server's network interfaces on Linux and map each one to its MAC address, link state and PCI address
- Explain how async/await lets one thread run many I/O-bound tasks concurrently, and write a Python asyncio program that shows the speed-up
- Use Git to commit, branch, merge, inspect history and safely undo changes
- Do core Linux admin tasks: manage users and file permissions, install packages, and read and write a systemd service unit
- Build and run a container image from a Dockerfile, and explain what is isolated from the host and what is shared
- Read a process's resident memory and a cgroup's memory usage, limit and page cache, and explain when the kernel OOM-kills a process

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [Network interface card (NIC)](#network-interface-card)
2. [Asynchronous programming (async/await)](#asynchronous-programming)
3. [Git version control](#git-version-control)
4. [Linux system administration basics](#linux-system-administration-basics)
5. [Containers and container images](#containers-and-container-images)
6. [Linux memory and cgroups](#linux-memory-and-cgroups)
7. [Build task: Containerised async inventory agent](#build-task)

<a id="network-interface-card"></a>
## 1. Network interface card (NIC)

*Builds on: Server hardware basics (ch. 1)*

### Before you read

- A server has one network card with two ports. How many network interfaces do you think Linux will list for that card: one or two?
- Does a MAC address belong to the server or to the network card?

<details>
<summary>Answers</summary>

- **A server has one network card with two ports. How many network interfaces do you think Linux will list for that card: one or two?** Usually two. Each port normally shows up as its own PCI function (for example 0000:41:00.0 and 0000:41:00.1) and its own Linux interface, each with its own MAC address.
- **Does a MAC address belong to the server or to the network card?** To the network card, or more exactly to each port on it. Move the card to another server and the MAC address goes with it.

</details>

### Explanation

A **network interface card (NIC)** is the hardware that connects a server to a network. In servers it is usually a PCIe card or a chip on the motherboard, so everything from Chapter 1 about PCIe devices and slot addresses applies to it.

What a NIC has:

- **Ports.** The physical sockets that a cable or optical module plugs into. A card can have one, two or more. Each port usually appears to the OS as a separate **PCI function**, for example `41:00.0` and `41:00.1`.
- **A MAC address per port.** Burned in at the factory. The network uses it to identify that port, and provisioning systems often use it to recognise a machine when it first boots.
- **A link speed and state.** The speed is something like 1, 25, 100 or 400 Gb/s, and the link is either up or down. Up means a cable is connected and the device at the other end is talking.
- **Firmware and a driver.** The firmware runs on the card. The driver is the kernel module that lets Linux use it, for example `mlx5_core` for NVIDIA ConnectX cards.

Linux exposes each port as a **network interface**, a named object such as `enp65s0f0` or `eth0`. Modern distributions use *predictable names* built from the PCI location: `en` (Ethernet) + `p65` (PCI bus 65, in decimal) + `s0` (slot 0) + `f0` (function 0). Not every interface is a NIC. `lo` (loopback), `docker0`, `veth…` and bridges are **virtual interfaces** that exist only in software. A quick test: a physical interface has a `device` link under `/sys/class/net/<name>/` that points to its PCI device. A virtual one doesn't.

You will meet two more kinds of network port later in the course:

- **The BMC's management port.** A separate, low-speed port used for out-of-band control.
- **SmartNICs or DPUs**, such as NVIDIA BlueField. These are NICs with their own CPU cores that can run software. The host still sees a DPU as a NIC, but it is also a small computer.

The main tools are `ip link` and `ip addr` (interfaces, MACs, state), `ethtool <if>` (speed, driver) and `lspci` (the card as a PCI device).

**Analogy.** A NIC is like the mail slot in a building's front door. Each slot (port) has its own address plate (MAC), and letters only reach the building through a slot. The analogy breaks down because a mail slot is passive. A NIC has firmware, offload features and sometimes a whole CPU (a DPU), so it can filter, encrypt or route traffic before the host ever sees it.

### Worked example: Inventory the network interfaces on your machine

**Step 1: List all interfaces briefly.**

On Linux:
```bash
ip -br link
```
Example output:
```
lo        UNKNOWN  00:00:00:00:00:00 <LOOPBACK,UP,LOWER_UP>
enp3s0    UP       3c:ec:ef:12:34:56 <BROADCAST,MULTICAST,UP,LOWER_UP>
docker0   DOWN     02:42:9a:bc:de:f0 <NO-CARRIER,BROADCAST,MULTICAST,UP>
```
The second column is the operational state. The flags in `< >` include `UP` when the interface is administratively enabled, which is why `docker0` shows state DOWN but has `UP` in its flags.

**On macOS:** `networksetup -listallhardwareports` lists the Mac's own ports. To practise the Linux steps, start a container with `docker run --rm -it debian:stable-slim bash`. That image has no `ip`, `lspci` or `ethtool`, and there is no `enp3s0`. Inside it, only run the sysfs commands in steps 2 to 4, using `eth0` in place of `enp3s0`. If you want `ip -br link` too, run `apt-get update && apt-get install -y iproute2` first. You will only see virtual interfaces, which is a useful result in itself.

**Step 2: Separate physical from virtual.**

```bash
ls -l /sys/class/net/
```
Physical interfaces link to paths under `/sys/devices/pci...`. Virtual ones link under `/sys/devices/virtual/net/...`. In a container on macOS, `eth0` and `lo` both point under `virtual`.

**Step 3: Map the interface to its PCI address.**

On a Linux host with a physical NIC:
```bash
readlink -f /sys/class/net/enp3s0/device
# /sys/devices/pci0000:00/0000:00:1c.0/0000:03:00.0
lspci -s 03:00.0
```
The interface `enp3s0` (bus 3, slot 0) is PCI device `0000:03:00.0`.

In the macOS container, run `readlink -f /sys/class/net/eth0` instead. It resolves to a path under `/sys/devices/virtual/net/`, and `/sys/class/net/eth0/device` doesn't exist, because `eth0` is a veth end and not a PCI device.

**Step 4: Read MAC, speed and driver.**

```bash
cat /sys/class/net/enp3s0/address
sudo ethtool enp3s0 | grep -E 'Speed|Link detected'
ethtool -i enp3s0 | grep driver
```
If `ethtool` is missing, install it with `sudo apt install ethtool` or `sudo dnf install ethtool`. In the macOS container, only `cat /sys/class/net/eth0/address` applies.

### Your turn: finish it

Fill in the blanks so that this script prints every interface with its MAC address and whether it is physical or virtual.

```text
#!/bin/sh
for path in /sys/class/net/*; do
  name=$(basename "$path")
  mac=$(cat "$path/___")
  if [ -e "$path/___" ]; then kind=physical; else kind=virtual; fi
  echo "$name $mac $kind"
done
```

<details>
<summary>Answer</summary>

The first blank is `address` and the second is `device`: `mac=$(cat "$path/address")` and `if [ -e "$path/device" ]; ...`. Physical NIC ports have a `device` symlink to their PCI device. Virtual interfaces such as `lo` and `veth*` don't.

</details>

### Your turn: on your own

A server's `ip -br link` shows an interface called `enp65s0f1`. What is the full PCI address of the NIC port behind it, and what can you say about the card from the name alone?

<details>
<summary>Hint 1</summary>

Split the name into parts: en / p65 / s0 / f1.

</details>

<details>
<summary>Hint 2</summary>

The numbers in predictable names are decimal, but PCI addresses are written in hexadecimal.

</details>

<details>
<summary>Hint 3</summary>

65 decimal = 0x41. The format is domain:bus:slot.function.

</details>

<details>
<summary>Answer</summary>

The address is `0000:41:00.1`: bus 65 decimal = 0x41, slot 0, function 1. Function 1 means this is at least the second port of a multi-port card, and its sibling is probably `enp65s0f0` at `0000:41:00.0`. Confirm it with `readlink -f /sys/class/net/enp65s0f1/device` or `lspci -s 41:00.1`.

</details>

### Explain it

In your own words: Why would a bare-metal provisioning system identify a brand-new machine by a NIC's MAC address rather than by its hostname or IP address?

### Check

**1. Which of these is a physical NIC port?**

A. lo
B. docker0
C. enp129s0f0
D. veth3a1b2c

<details>
<summary>Answer</summary>

**C.** enp129s0f0

`enp129s0f0` encodes a PCI bus, slot and function, so it points to real hardware. `lo` is the software loopback, `docker0` is a software bridge Docker creates, and `veth*` is one end of a virtual cable pair. All three exist only in the kernel.

</details>

**2. You move a dual-port NIC from server A to server B. What happens to its two MAC addresses?**

A. They move with the card to server B
B. They stay with server A's motherboard
C. Server B's BIOS assigns new ones
D. They merge into one MAC for the card

<details>
<summary>Answer</summary>

**A.** They move with the card to server B

Burned-in MAC addresses are stored on the NIC itself, one per port. The motherboard and BIOS don't own them. Software can override a MAC, but by default the address travels with the card.

</details>

**3. In `ip -br link`, an interface's state column says DOWN, and its flags include both UP and NO-CARRIER. What does that most likely mean?**

A. The driver isn't loaded
B. The interface is enabled, but there is no working physical link (no cable, or the far end is down)
C. The interface has no IP address
D. The MAC address is invalid

<details>
<summary>Answer</summary>

**B.** The interface is enabled, but there is no working physical link (no cable, or the far end is down)

The UP flag means the admin has enabled the interface. NO-CARRIER means the NIC sees no link signal, so the operational state is DOWN. If the driver weren't loaded, the interface wouldn't appear at all. IP addresses belong to a separate layer and don't affect carrier.

</details>

**Sources:** general background knowledge; no NICo docs page covers this directly.

<a id="asynchronous-programming"></a>
## 2. Asynchronous programming (async/await)

### Before you read

- A program must check the health of 1,000 servers, and each check waits about 1 second for a network reply. Checking them one after another takes about 1,000 seconds. Roughly how fast could one thread do it if it didn't sit idle while waiting?
- Does async/await make CPU-heavy work, such as compressing a file, faster?

<details>
<summary>Answers</summary>

- **A program must check the health of 1,000 servers, and each check waits about 1 second for a network reply. Checking them one after another takes about 1,000 seconds. Roughly how fast could one thread do it if it didn't sit idle while waiting?** Close to 1 second, plus overhead. The thread sends all the requests, then handles the replies as they arrive. Almost all of the 1,000 seconds was spent waiting, not computing.
- **Does async/await make CPU-heavy work, such as compressing a file, faster?** No. Async helps when tasks spend their time waiting for I/O. CPU-bound work needs more cores (threads or processes) to go faster.

</details>

### Explanation

Most infrastructure software spends its time **waiting**: for a database query, an HTTP reply from a server's BMC, a disk read. In plain blocking code, a thread that calls `read()` sits idle until data arrives. One way to handle many requests at once is one thread per request, but threads cost memory and context switches, so that approach stops scaling at a few thousand.

**Asynchronous programming** works differently. A task that needs to wait gives control back, and the thread runs another task in the meantime. The pieces:

- **Coroutine / async function.** A function declared with `async def` (Python) or `async fn` (Rust). Calling it doesn't run it yet. It returns an object that represents work to be done.
- **`await`.** Marks a point where the task may pause until a result is ready. While it is paused, other tasks run.
- **Event loop / runtime.** The scheduler that tracks paused tasks, watches which I/O is ready (using OS facilities such as `epoll` on Linux) and resumes the right task. In Python this is `asyncio`. In Rust it is usually **Tokio**, which runs tasks on a small pool of worker threads. You will tune Tokio in chapter 16.
- **Concurrency vs parallelism.** Async gives you *concurrency*: many tasks in progress at once. It doesn't give you *parallelism* (work running at the same moment on several cores) unless the runtime uses several threads.

The golden rule is **don't block inside async code**. A blocking call such as `time.sleep()`, a CPU-heavy loop, or a synchronous file or network call holds the thread and never gives control back. Every other task on that thread stalls. In Python, use `await asyncio.sleep()` and async libraries. In Rust, use Tokio's async I/O, or `spawn_blocking` for blocking work you can't avoid.

Async is **cooperative**. Tasks only switch at `await` points. You need fewer locks than with threads, but one misbehaving task can freeze all the others.

**Analogy.** A restaurant waiter takes an order, hands it to the kitchen and serves other tables while the food cooks. They don't stand at the kitchen door waiting. One waiter can serve many tables this way. The analogy breaks down because a real waiter notices a stuck table and moves on. If an async task 'cooks the meal itself' (does blocking or CPU-heavy work), the event loop can't interrupt it, and every other table waits.

### Worked example: Sequential vs concurrent 'BMC checks' in Python asyncio

**Step 1: Write a coroutine that simulates a network call.**

Save this as `checks.py`:
```python
import asyncio
import time


async def check(host):
    await asyncio.sleep(1)  # stands in for a 1-second network round trip
    return f"{host}: ok"


async def main():
    hosts = [f"bmc-{i}" for i in range(5)]

    start = time.perf_counter()
    for h in hosts:
        print(await check(h))
    print(f"sequential: {time.perf_counter() - start:.1f}s")

    start = time.perf_counter()
    results = await asyncio.gather(*(check(h) for h in hosts))
    print(results)
    print(f"concurrent: {time.perf_counter() - start:.1f}s")


asyncio.run(main())
```

**Step 2: Run it and compare the timings.**

```bash
python3 checks.py
```
The sequential loop takes about **5.0s** because each `await` finishes before the next check starts. `gather` takes about **1.0s**: all five tasks pause at `asyncio.sleep` together, and the loop wakes each one when its timer fires. Both run on one thread.

**Step 3: Break it on purpose with a blocking call.**

In `check`, replace `await asyncio.sleep(1)` with `time.sleep(1)` and run the script again. The 'concurrent' section now also takes about 5s. `time.sleep` blocks the thread without giving control back, so `gather` has nothing to overlap.

**Step 4: Connect it to real systems.**

Replace the sleep with real I/O, such as an async HTTP request to a BMC, a database query or a gRPC call. The pattern stays the same: start many awaits and let the runtime overlap the waiting. Rust services built on Tokio work the same way, except Tokio can also spread tasks across several worker threads.

### Your turn: finish it

Fill in the blanks so the program runs four `ping` calls concurrently, prints `[0, 2, 4, 6]`, and finishes in about 0.5 seconds.

```text
import asyncio


async def ping(n):
    await asyncio.sleep(0.5)
    return n * 2


async def main():
    results = await asyncio.___(*(ping(n) for n in range(4)))
    print(results)


___(main())
```

<details>
<summary>Answer</summary>

The first blank is `gather` (`results = await asyncio.gather(*(ping(n) for n in range(4)))`) and the second is `asyncio.run` (`asyncio.run(main())`). `gather` runs the coroutines concurrently and returns their results in the order you passed them. `asyncio.run` creates the event loop, runs `main()` until it finishes, then closes the loop.

</details>

### Your turn: on your own

Extend the worked example. Hosts now have different delays, `{"bmc-0": 1, "bmc-1": 1, "bmc-2": 10}`, and `bmc-2` is effectively hung. Change the program so that all three checks run concurrently, any check that takes longer than 2 seconds reports `"<host>: timeout"`, and the whole run finishes in about 2 seconds.

<details>
<summary>Hint 1</summary>

`asyncio` has a function that wraps an awaitable with a time limit.

</details>

<details>
<summary>Hint 2</summary>

`asyncio.wait_for(coro, timeout=2)` raises `TimeoutError` (`asyncio.TimeoutError` before Python 3.11) if the time runs out.

</details>

<details>
<summary>Hint 3</summary>

Wrap each check in a helper that puts try/except around `await asyncio.wait_for(...)`, then `gather` the helpers.

</details>

<details>
<summary>Answer</summary>

```python
import asyncio
import time


async def check(host, delay):
    await asyncio.sleep(delay)
    return f"{host}: ok"


async def safe_check(host, delay):
    try:
        return await asyncio.wait_for(check(host, delay), timeout=2)
    except asyncio.TimeoutError:
        return f"{host}: timeout"


async def main():
    hosts = {"bmc-0": 1, "bmc-1": 1, "bmc-2": 10}
    start = time.perf_counter()
    results = await asyncio.gather(*(safe_check(h, d) for h, d in hosts.items()))
    print(results)
    print(f"{time.perf_counter() - start:.1f}s")


asyncio.run(main())
```
The output is `['bmc-0: ok', 'bmc-1: ok', 'bmc-2: timeout']` after about 2.0s. Real infrastructure code needs timeouts like this. Without one, a single unresponsive BMC can hold a task open forever.

</details>

### Explain it

In your own words: Why does one blocking call such as `time.sleep(1)` inside an async function slow down every other task, when the same call in a thread-per-request program only slows down its own request?

### Check

**1. Ten tasks, each running `time.sleep(1)` (not `asyncio.sleep`), are run with `asyncio.gather` on one event loop. About how long does it take?**

A. About 1 second
B. About 10 seconds
C. About 0.1 seconds
D. It raises an error

<details>
<summary>Answer</summary>

**B.** About 10 seconds

`time.sleep` blocks the only thread and never gives control back to the loop, so the tasks run one after another. People expect 1 second because they think `gather` creates parallelism by itself. It only overlaps waits that `await` something the loop manages.

</details>

**2. Which workload benefits most from async/await?**

A. Resizing 10,000 images
B. Training a neural network on one GPU
C. Polling 10,000 servers' HTTP APIs
D. Sorting a large array in memory

<details>
<summary>Answer</summary>

**C.** Polling 10,000 servers' HTTP APIs

Polling is mostly waiting on the network, which is exactly the kind of I/O wait that async overlaps. The other three are CPU- or GPU-bound. Async adds nothing there; they need more cores or accelerators.

</details>

**3. In Python, what does calling `check("bmc-0")` return if `check` is defined with `async def`?**

A. The function's return value
B. A coroutine object that hasn't run yet
C. A new OS thread
D. None

<details>
<summary>Answer</summary>

**B.** A coroutine object that hasn't run yet

An async function doesn't run until something awaits or schedules it (`await`, `asyncio.run`, `gather`, `create_task`). If you forget `await`, you get a 'coroutine was never awaited' warning and the work never happens.

</details>

**Sources:** general background knowledge; no NICo docs page covers this directly.

<a id="git-version-control"></a>
## 3. Git version control

### Before you read

- In Git, is a commit a record of *what changed* (a diff) or a snapshot of *all tracked files* at that moment?
- Creating a branch in Git copies the whole project. True or false?

<details>
<summary>Answers</summary>

- **In Git, is a commit a record of *what changed* (a diff) or a snapshot of *all tracked files* at that moment?** Conceptually it is a snapshot of every tracked file, plus metadata and a pointer to the parent commit. Git computes diffs by comparing snapshots.
- **Creating a branch in Git copies the whole project. True or false?** False. A branch is just a movable pointer to a commit (a tiny file holding a commit hash). That is why creating one is instant.

</details>

### Explanation

**Git** is a version-control system. It records the history of a set of files so you can see who changed what, when and why, and go back when something breaks. Infrastructure teams keep configuration, deployment manifests and code in Git. Chapter 17's GitOps approach goes further and treats a Git repository as the source of truth for what should be running.

Core terms:

- **Repository (repo).** A project directory plus a hidden `.git/` folder holding the full history.
- **Working tree.** The files you edit.
- **Staging area (index).** The changes you have marked for the next commit with `git add`. This lets you commit some edits and leave others for later.
- **Commit.** A snapshot of the staged files with an author, message, timestamp and pointer to its parent commit(s). It is identified by a hash such as `3f2a9c1`. Commits never change. 'Editing history' really means creating new commits.
- **Branch.** A named pointer to a commit that moves forward as you commit. `main` is the usual default. **HEAD** is the branch or commit you currently have checked out.
- **Merge.** Combining another branch's commits into the current one. If both sides changed the same lines, you get a **conflict** to resolve by hand.
- **Remote.** Another copy of the repo, such as one on GitHub or GitLab. `git clone` copies it, `git pull` fetches and merges its changes, and `git push` uploads yours.

A typical workflow: create a branch, edit, `git add`, `git commit`, push, open a review (pull request), merge to `main`.

To undo safely on a shared branch, use `git revert <hash>`. It adds a new commit that reverses an old one, so nobody else's history changes. `git reset` moves a branch pointer backwards. That is fine for local work, but it rewrites history that others may already have.

**Analogy.** Git is like a video game save system where every save is kept forever and labelled. Branches are bookmarks to particular saves that you can keep playing from. The analogy breaks down because game saves are separate timelines that never combine, whereas Git can merge two lines of history into one and asks you to sort out the places where they disagree.

### Worked example: Commit, branch, merge and inspect history

**Step 1: Set your identity (once per machine).**

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

**Step 2: Create a repo and the first commit.**

```bash
mkdir git-demo && cd git-demo
git init -b main
printf 'site = "rack1"\n' > site.toml
git status          # site.toml is untracked
git add site.toml   # stage it
git commit -m "Add site config"
```
`-b main` needs Git 2.28 or later. On older versions, run `git init` and then `git branch -m main`.

**Step 3: Make a change on a branch.**

```bash
git switch -c add-region
echo 'region = "west"' >> site.toml
git diff                # see the unstaged change
git commit -am "Add region to site config"
```
`-a` stages changes to files Git already tracks. It doesn't add new files.

**Step 4: Merge back and view history.**

```bash
git switch main
cat site.toml           # no region line yet: main hasn't moved
git merge add-region    # fast-forward
git log --oneline --graph
git show HEAD           # what the latest commit changed
```

**Step 5: Find who changed a line.**

```bash
git blame site.toml
git log -p -- site.toml
```
`git blame` shows each line next to the commit that last touched it.

### Your turn: finish it

Fill in the blanks. You are on `main` in a clean repo and want to add a new file `rack2.toml` on a branch called `rack2`, then commit it.

```text
git ___ rack2
printf 'site = "rack2"\n' > rack2.toml
git ___ rack2.toml
git commit -m "Add rack2 config"
```

<details>
<summary>Answer</summary>

The first blank is `switch -c` (`git switch -c rack2`), which creates the branch and switches to it. `git checkout -b rack2` also works. The second blank is `add` (`git add rack2.toml`). A new file must be staged explicitly, because `git commit -a` only picks up files Git already tracks.

</details>

### Your turn: on your own

On the shared `main` branch, a teammate's commit `9c1e7d2` changed `region = "west"` to `region = "wst"`, and that broke a deployment. Others have already pulled `main`. Undo that commit without rewriting history, and check that the file is fixed.

<details>
<summary>Hint 1</summary>

Others already have the commit, so don't move `main` backwards.

</details>

<details>
<summary>Hint 2</summary>

There is a Git command that creates a new commit which applies the opposite of an old one.

</details>

<details>
<summary>Hint 3</summary>

`git revert 9c1e7d2`, then look at the file and `git log --oneline`.

</details>

<details>
<summary>Answer</summary>

```bash
git switch main
git pull
git revert 9c1e7d2      # opens an editor for the message; save and close
grep region site.toml   # region = "west"
git log --oneline       # top: Revert "..."
git push
```
`git revert` keeps history intact and adds a new commit that undoes the bad one. `git reset --hard` followed by a force-push would rewrite the shared history and break everyone else's copies.

</details>

### Explain it

In your own words: Why is it useful to have a staging area between 'edit files' and 'commit', rather than committing everything that changed?

### Check

**1. You ran `git commit -am "msg"` but your brand-new file `notes.md` isn't in the commit. Why?**

A. `-a` only stages files Git already tracks
B. Markdown files are ignored by default
C. You must push before new files are recorded
D. Commits only store diffs of existing files

<details>
<summary>Answer</summary>

**A.** `-a` only stages files Git already tracks

New (untracked) files need an explicit `git add`. Git has no default rule that ignores .md files (only `.gitignore` excludes files), and pushing has nothing to do with what goes into a local commit.

</details>

**2. What is a Git branch, technically?**

A. A full copy of the repository
B. A movable pointer to a commit
C. A diff against main
D. A remote server

<details>
<summary>Answer</summary>

**B.** A movable pointer to a commit

A branch is a reference holding one commit hash, and it moves forward when you commit on it. That is why branching is instant and cheap, unlike copying a directory.

</details>

**3. Which command is the safe way to undo a commit that teammates have already pulled?**

A. git reset --hard HEAD~1 && git push --force
B. git revert <hash>
C. git rm <file>
D. git checkout <hash>

<details>
<summary>Answer</summary>

**B.** git revert <hash>

`revert` adds a new commit that reverses the old one, so shared history is untouched. Reset plus force-push rewrites history others depend on. `git rm` deletes a file. `git checkout <hash>` only moves your local HEAD.

</details>

**Sources:** general background knowledge; no NICo docs page covers this directly.

<a id="linux-system-administration-basics"></a>
## 4. Linux system administration basics

### Before you read

- A file shows `-rw-r-----  1 root adm  ... syslog`. Can a normal user who isn't in the `adm` group read it?
- On most Linux servers, which program starts long-running services such as sshd at boot and restarts them if they crash?

<details>
<summary>Answers</summary>

- **A file shows `-rw-r-----  1 root adm  ... syslog`. Can a normal user who isn't in the `adm` group read it?** No. The owner (root) can read and write it, members of group `adm` can read it, and everyone else has no permissions (`---`).
- **On most Linux servers, which program starts long-running services such as sshd at boot and restarts them if they crash?** systemd. It is PID 1 on most modern distributions. You control it with `systemctl` and read its logs with `journalctl`.

</details>

### Explanation

You configure a Linux server through four main things: **users, files, packages and services**.

**Users and groups.** Every process runs as a user (UID) and a set of groups (GIDs). `root` (UID 0) can do anything. Services should run as dedicated unprivileged users, so a bug can only damage what that user owns. Users are listed in `/etc/passwd` and groups in `/etc/group`. The commands are `useradd`, `usermod -aG <group> <user>`, `id`, and `sudo` to run one command as root.

**Files and permissions.** In Linux, almost everything is a file. That includes config in `/etc`, logs in `/var/log`, programs in `/usr/bin`, and kernel information in `/proc` and `/sys` (you used `/sys/class/net` in lesson 1). Each file has an owner, a group and three permission sets (user/group/other) of **r**ead, **w**rite and e**x**ecute. These are often written in octal, with r=4, w=2, x=1, so `750` means `rwxr-x---`. Change permissions with `chmod` and ownership with `chown`.

**Packages.** Software is installed from distribution repositories by a **package manager**, which also handles dependencies and updates. Debian and Ubuntu use `apt` (`apt-get update && apt-get install -y curl`). Fedora, RHEL and Rocky use `dnf`. Packages put files in standard places and often install a service.

**Services and processes.** A **process** is a running program with a PID. You can list processes with `ps aux` or `top`. **systemd** is the first process started at boot (PID 1). It starts **units** described by small INI-style files in `/etc/systemd/system/`. You manage them with `systemctl start|stop|restart|status|enable <unit>`, where `enable` means 'start at boot', and read their logs with `journalctl -u <unit>`. After you change a unit file, run `systemctl daemon-reload` so systemd picks up the change.

Unit files express dependencies in two separate ways. `Wants=` (or the stricter `Requires=`) says *which* other units must also be started. `After=` only says *in what order* they start. `After=` on its own doesn't pull anything in, so a service that needs the network usually has both `Wants=network-online.target` and `After=network-online.target`.

These pieces come up throughout the rest of the course. Containers (next lesson) are processes with extra isolation. Cgroups (the lesson after) are files under `/sys/fs/cgroup`, and systemd itself uses them to track every service.

**Analogy.** A Linux server is like an office building. Users are staff with ID badges, permissions decide which rooms each badge opens, the package manager is the approved supplier catalogue, and systemd is the facilities manager who opens the building each morning and restarts the coffee machine when it breaks. The analogy breaks down because `root` isn't just a manager with a master key. Root can rewrite the rules themselves, which is why you avoid running services as root.

### Worked example: Users, permissions and packages in a throwaway Debian system

**Step 1: Start a disposable Linux shell.**

```bash
docker run --rm -it debian:stable-slim bash
```
You are root inside a minimal Debian system, and anything you break disappears when you exit. Containers usually don't run systemd, so you will do the services step on a real Linux host.

**Step 2: Create a user and check identities.**

```bash
useradd -m -s /bin/bash alice
id alice
grep alice /etc/passwd
```
The passwd line has the format `name:x:UID:GID:comment:home:shell`.

**Step 3: Lock down a file and test it.**

```bash
mkdir -p /srv/app && echo 'token=abc' > /srv/app/secret.txt
chmod 600 /srv/app/secret.txt
ls -l /srv/app/secret.txt         # -rw------- root root
su alice -c 'cat /srv/app/secret.txt'   # Permission denied
chown alice /srv/app/secret.txt
su alice -c 'cat /srv/app/secret.txt'   # token=abc
```

**Step 4: Install a package.**

```bash
command -v sysctl || echo 'sysctl not installed'   # prints: sysctl not installed
apt-get update && apt-get install -y procps
sysctl net.ipv4.ip_forward         # now works
dpkg -L procps | grep bin/          # files the package installed
```
`command -v` prints a program's path if it exists and fails if it doesn't. `sysctl` lives in the `procps` package, which slim images leave out. The same package also provides `ps`, `free` and `top`.

**Step 5: Inspect a service on a real Linux host.**

Exit the container. On a Linux machine with systemd (a laptop or a VM):
```bash
systemctl status ssh        # or sshd on Fedora/RHEL
journalctl -u ssh -n 20     # last 20 log lines
systemctl list-units --type=service --state=running
```

### Your turn: finish it

Fill in the blanks in this systemd unit, saved as `/etc/systemd/system/agent.service`. It should wait for the network to be up, restart the agent only when it exits with an error, and start it at normal multi-user boot.

```text
[Unit]
Description=Inventory agent
Wants=network-online.target
After=network-online.target

[Service]
User=agent
ExecStart=/usr/bin/python3 /opt/agent/agent.py
Restart=___

[Install]
WantedBy=___
```

<details>
<summary>Answer</summary>

The blanks are `Restart=on-failure` and `WantedBy=multi-user.target`. `Wants=network-online.target` pulls the 'network is up' target into the boot, and `After=network-online.target` makes the agent start only once that target is reached. With `After=` alone, nothing guarantees the target is started at all. To activate the unit, run `sudo useradd --system agent`, then `sudo systemctl daemon-reload` and `sudo systemctl enable --now agent.service`. Check it with `systemctl status agent` and `journalctl -u agent`.

</details>

### Your turn: on your own

You have a script `/opt/tools/collect.sh` owned by user `ops`, group `infra`. Requirements: `ops` can read, edit and run it; members of `infra` can read and run it but not edit it; nobody else can do anything. Give the `chmod` command and the `ls -l` permission string you expect. Then explain how you would let user `bob` run it.

<details>
<summary>Hint 1</summary>

Work out the three permission sets separately: user, group, other.

</details>

<details>
<summary>Hint 2</summary>

r=4, w=2, x=1. Add them up for each set.

</details>

<details>
<summary>Hint 3</summary>

User = rwx = 7, group = r-x = 5, other = --- = 0. For bob, think about groups rather than permissions.

</details>

<details>
<summary>Answer</summary>

`chmod 750 /opt/tools/collect.sh` gives `-rwxr-x---`. To let bob run it, add him to the group with `sudo usermod -aG infra bob`. bob must log in again (or run `newgrp infra`) before the new group takes effect. Don't make the file world-executable or give bob root.

</details>

### Explain it

In your own words: Why is it good practice to run a network service as its own unprivileged user rather than as root, even on a machine that runs nothing else?

### Check

**1. You edited `/etc/systemd/system/agent.service`, ran `systemctl restart agent`, and the old settings are still in effect. What did you miss?**

A. systemctl daemon-reload
B. apt-get update
C. chmod +x on the unit file
D. Rebooting the network

<details>
<summary>Answer</summary>

**A.** systemctl daemon-reload

systemd caches unit files and only rereads them after `daemon-reload`. Unit files don't need execute permission, and apt has nothing to do with it.

</details>

**2. What does `chmod 640 file` produce?**

A. -rw-r-----
B. -rwxr-----
C. -rw-rw----
D. -r--r-----

<details>
<summary>Answer</summary>

**A.** -rw-r-----

6 = 4+2 = rw for the owner, 4 = r for the group, 0 = nothing for others. A common slip is to think 6 includes execute, but execute is 1.

</details>

**3. A unit has `After=network-online.target` but no `Wants=` or `Requires=` for it. What does the `After=` line guarantee?**

A. That the network target is started before this service
B. Only that, if the network target is being started anyway, this service starts after it
C. That the service restarts when the network goes down
D. Nothing; After= is ignored without Requires=

<details>
<summary>Answer</summary>

**B.** Only that, if the network target is being started anyway, this service starts after it

`After=` controls ordering only. It doesn't pull the other unit in, which is what `Wants=` or `Requires=` do. It isn't ignored, though: when both units are part of the same boot, the order is enforced.

</details>

**Sources:** general background knowledge; no NICo docs page covers this directly.

<a id="containers-and-container-images"></a>
## 5. Containers and container images

*Builds on: Linux system administration basics (ch. 2)*

### Before you read

- Does a Linux container run its own separate kernel, like a virtual machine does?
- You start a container, create a file inside it, then delete the container and start a new one from the same image. Is the file still there?

<details>
<summary>Answers</summary>

- **Does a Linux container run its own separate kernel, like a virtual machine does?** No. A container is an ordinary process on the host kernel, isolated with namespaces and limited with cgroups. That is why it starts in milliseconds, and why an arm64 image can't run natively on an amd64 host.
- **You start a container, create a file inside it, then delete the container and start a new one from the same image. Is the file still there?** No. Each container gets its own thin writable layer on top of the read-only image, and that layer is thrown away with the container. Use a volume for data that must persist.

</details>

### Explanation

A **container image** is a packaged filesystem: an application plus every library and file it needs, along with metadata such as which command to run and which environment variables to set. A **container** is a running instance of an image. It is a normal Linux process (from the last lesson) with extra isolation.

Where the isolation comes from:

- **Namespaces** give the process its own view of the system: its own process list (it sees itself as PID 1), its own network interfaces (a `veth` pair, as in lesson 1), its own hostname and mount table, and optionally its own user IDs.
- **Cgroups** limit and count how much CPU and memory it can use. That is the next lesson.
- The **kernel is shared** with the host, so there is no guest OS to boot. This is why containers start fast. It is also why the image must match the host's CPU architecture (chapter 1) unless you use emulation.

Images are made of **layers**. Each Dockerfile instruction that changes files (`RUN`, `COPY`, `ADD`) adds a read-only layer. Other instructions, such as `CMD` and `ENV`, only change the image's metadata. Layers are cached and shared between images, so after a code change, a rebuild only redoes the steps from that change onwards. When a container starts, it gets a thin writable layer on top. That layer is lost when the container is removed, so data that must survive goes in **volumes** (`-v`).

Common Dockerfile instructions. A `#` only starts a comment at the beginning of a line, so each comment sits on its own line:

```dockerfile
# base image
FROM python:3.12-slim
# cd into /app (creates it if needed)
WORKDIR /app
# copy a file from the build context
COPY app.py .
# run a command at build time
RUN pip install requests
# default environment variable
ENV PORT=8000
# run as a non-root UID
USER 10001
# what to run when the container starts
CMD ["python", "app.py"]
```

Images are named `registry/repository:tag`, for example `docker.io/library/python:3.12-slim`. A tag such as `3.12-slim` can be moved to point at a different image. A **digest** (`@sha256:…`) identifies exact content and never changes. You upload images to a **registry** with `docker push` and download them with `docker pull`. Docker and Podman use the same OCI image format, and `podman` accepts the same commands.

**Analogy.** An image is like a shipping container packed at the factory: everything it needs is inside and sealed, and it fits any standard ship. The analogy breaks down in two places. A real shipping container keeps its contents completely isolated, but software containers share the host's kernel. And a software image is a stack of layers that can be shared between images, not a single box.

### Worked example: Build, run and inspect a tiny web container

**Step 1: Create the build context.**

```bash
mkdir hello-web && cd hello-web
echo '<h1>hello from a container</h1>' > index.html
cat > Dockerfile <<'EOF'
FROM python:3.12-slim
WORKDIR /srv
COPY index.html .
EXPOSE 8000
CMD ["python", "-m", "http.server", "8000"]
EOF
```

**Step 2: Build the image and look at its layers.**

```bash
docker build -t hello-web:1 .
docker image ls hello-web
docker image history hello-web:1
```
The top four entries are your instructions, newest first: `CMD`, `EXPOSE`, `COPY` and `WORKDIR`. Only `COPY` adds a layer with non-zero size. The others are metadata (or an empty directory) and show about 0 B. Below them are the python base image's layers.

**Step 3: Run it with a port mapping.**

```bash
docker run -d --name web -p 8080:8000 hello-web:1
curl http://localhost:8080/
docker logs web 2>&1 | tail
```
`-p 8080:8000` maps host port 8080 to container port 8000. `http.server` logs to stderr, so you need `2>&1` to see its logs through `tail`.

**Step 4: See that it is just a process.**

```bash
docker top web                        # the process as the host sees it
docker exec web cat /etc/os-release   # Debian, from the image
docker exec web ls /sys/class/net     # eth0 and lo: its own network namespace
```
On a Linux host, `ps -ef | grep http.server` shows the same process in the host's process list.

**Step 5: Show that the writable layer is temporary.**

```bash
docker exec web sh -c 'echo temp > /srv/note.txt'
docker rm -f web
docker run --rm hello-web:1 ls /srv    # only index.html
```

### Your turn: finish it

Fill in the blanks so that `docker build -t greet . && docker run --rm greet` runs `greet.py` from the build directory.

```text
FROM python:3.12-slim
WORKDIR /app
___ greet.py .
CMD ["python", "___"]
```

<details>
<summary>Answer</summary>

The blanks are `COPY greet.py .` and `CMD ["python", "greet.py"]`. `COPY` puts the file from the build context into `/app` (the `WORKDIR`), and `CMD` runs it relative to that directory when the container starts.

</details>

### Your turn: on your own

You have this `app.py`:
```python
import http.server
import os

port = int(os.environ.get("PORT", "8000"))
handler = http.server.SimpleHTTPRequestHandler
http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
```
Write a Dockerfile that runs it as a non-root user and listens on port 9000 by default. Then write the `docker run` command that makes it reachable at `http://localhost:8080` on your laptop.

<details>
<summary>Hint 1</summary>

Use `ENV` to set the default port inside the image.

</details>

<details>
<summary>Hint 2</summary>

`USER` takes a UID. It doesn't have to exist in /etc/passwd, and a numeric UID such as 10001 is common.

</details>

<details>
<summary>Hint 3</summary>

Port mapping is `-p HOST:CONTAINER`.

</details>

<details>
<summary>Answer</summary>

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY app.py .
ENV PORT=9000
USER 10001
EXPOSE 9000
CMD ["python", "app.py"]
```
```bash
docker build -t portapp .
docker run -d --name portapp -p 8080:9000 portapp
curl -I http://localhost:8080/
docker exec portapp id    # uid=10001
```
`EXPOSE` is only documentation. The `-p` flag is what actually publishes the port.

</details>

### Explain it

In your own words: Why does a container start in well under a second when a virtual machine takes much longer, and what isolation do you give up in exchange?

### Check

**1. Which statement about containers is correct?**

A. Each container runs its own Linux kernel
B. Containers share the host kernel and are isolated with namespaces and cgroups
C. Containers are a type of virtual machine with a smaller disk
D. An amd64 host can run arm64 images natively

<details>
<summary>Answer</summary>

**B.** Containers share the host kernel and are isolated with namespaces and cgroups

Containers are host processes, so there is one shared kernel. The shared kernel is also why the image architecture must match the CPU unless you use emulation such as QEMU. 'Lightweight VM' is a common but wrong mental model.

</details>

**2. You change one line in `app.py` and rebuild. The Dockerfile has `RUN pip install -r requirements.txt` *after* `COPY . .`. Why is the rebuild slow?**

A. Docker always rebuilds every layer
B. Changing a file invalidates the COPY layer and every layer after it, including pip install
C. pip caches are disabled in containers
D. The base image is downloaded again each time

<details>
<summary>Answer</summary>

**B.** Changing a file invalidates the COPY layer and every layer after it, including pip install

The layer cache is invalidated from the first changed step onwards. Copy `requirements.txt` and run pip *before* copying the rest of the code, so the dependency install stays cached.

</details>

**3. What is the difference between `python:3.12-slim` and `python@sha256:<digest>`?**

A. None: they are aliases
B. The tag can be moved to point at new content; the digest always identifies the same bytes
C. The digest is the smaller image
D. Tags only work with Podman

<details>
<summary>Answer</summary>

**B.** The tag can be moved to point at new content; the digest always identifies the same bytes

Publishers re-point tags when they release patches. Pinning a digest gives reproducible deployments, which matters later when Kubernetes pulls images on many nodes.

</details>

**Sources:** general background knowledge; no NICo docs page covers this directly.

<a id="linux-memory-and-cgroups"></a>
## 6. Linux memory and cgroups

*Builds on: Linux system administration basics (ch. 2)*

### Before you read

- `free -m` on a Linux server shows only 300 MB 'free' out of 64 GB. Is the machine about to run out of memory?
- A container is limited to 100 MB of memory and its program tries to use 200 MB. What do you expect to happen?

<details>
<summary>Answers</summary>

- **`free -m` on a Linux server shows only 300 MB 'free' out of 64 GB. Is the machine about to run out of memory?** Probably not. Linux uses idle RAM as page cache (cached file data) and gives it back when programs need it. Look at the 'available' column, not 'free'.
- **A container is limited to 100 MB of memory and its program tries to use 200 MB. What do you expect to happen?** The kernel first tries to reclaim memory, such as page cache, and then the OOM killer kills a process in that container's cgroup. The container usually exits with code 137 (128 + 9, SIGKILL's signal number).

</details>

### Explanation

Linux keeps track of memory in a few different ways:

- **Virtual memory (VSZ).** The address space a process has *reserved*. It is often huge and mostly meaningless for capacity planning.
- **Resident set size (RSS).** The process's pages that are actually in physical RAM right now. See it with `ps -o pid,rss,comm` (in KiB) or the `VmRSS` line in `/proc/<pid>/status`.
- **Anonymous memory.** Heap and stack: data not backed by any file. Without swap, the kernel can't free it, so it stays in RAM until the process frees it or dies.
- **Page cache (file-backed memory).** Copies of file contents kept in RAM to speed up reads and writes. It is **reclaimable**: when memory runs short, the kernel drops clean cache pages, or writes dirty pages back to disk first. This is why `free` shows little 'free' memory but plenty 'available'. `/proc/meminfo` has the full breakdown.

A **control group (cgroup)** is a kernel feature that groups processes and *accounts for* and *limits* their resources: memory, CPU, I/O and PIDs. Modern systems use **cgroup v2**, a single hierarchy mounted at `/sys/fs/cgroup`, where each group is a directory of control files:

| File | Meaning |
|---|---|
| `memory.current` | bytes charged to the group now (anonymous + page cache + kernel) |
| `memory.max` | hard limit, or `max` for unlimited |
| `memory.stat` | breakdown: `anon`, `file`, `active_file`, `inactive_file`, ... |
| `memory.events` | counters, including `oom_kill` |

systemd puts every service in its own cgroup, and Docker puts every container in one. `docker run --memory=100m` simply writes to `memory.max`.

When a group reaches `memory.max`, the kernel first **reclaims** that group's page cache. If that isn't enough (usually because there is too much anonymous memory), the **OOM killer** sends SIGKILL to a process in the group. There is no warning and no cleanup, and the exit code is 137. Page cache counts towards `memory.current`, so a high number can look alarming when it is really harmless cache. In chapter 16 you will see that Kubernetes makes eviction decisions using a 'working set' figure built from these same counters.

**Analogy.** A cgroup memory limit is like a desk allocation in a shared office. Your own papers (anonymous memory) and your borrowed library books (page cache) both take up desk space. When the desk is full, the library books are taken back first, because they can be fetched again. If your own papers still don't fit, security removes you from the building (the OOM kill). The analogy breaks down because the real eviction comes with no warning or negotiation: SIGKILL can't be caught.

### Worked example: Watch a container's cgroup fill with cache, then get OOM-killed

**Step 1: Read memory on the host.**

On Linux:
```bash
free -m                      # compare 'free' with 'available'
grep -E 'MemTotal|MemAvailable|^Cached' /proc/meminfo
ps -o pid,rss,vsz,comm -p $$ # your shell's RSS vs VSZ, in KiB
```
**On macOS**, run the same commands inside a container. They will describe Docker's Linux VM. Slim images don't include `free` or `ps` (both come from the `procps` package), so install it first:
```bash
docker run --rm -it debian:stable-slim bash
# inside:
apt-get update && apt-get install -y procps
free -m
grep -E 'MemTotal|MemAvailable|^Cached' /proc/meminfo
ps -o pid,rss,vsz,comm -p $$
```
If you'd rather skip the install, use only the files in `/proc`, which every Linux system has: `grep -E 'MemTotal|MemAvailable|^Cached' /proc/meminfo` and `grep -E 'VmSize|VmRSS' /proc/$$/status` (VmSize is VSZ, VmRSS is RSS).

**Step 2: Start a memory-limited container and read its limit.**

```bash
docker run --rm -it --memory=100m --memory-swap=100m python:3.12-slim bash
# inside:
cat /sys/fs/cgroup/memory.max       # 104857600
cat /sys/fs/cgroup/memory.current
```
Setting `--memory-swap=100m` equal to `--memory` disables swap. Without it, Docker allows extra swap and the OOM demo may not trigger. If `memory.max` doesn't exist, your host uses the older cgroup v1.

**Step 3: Fill page cache and watch it get charged.**

```bash
grep -E '^(anon|file) ' /sys/fs/cgroup/memory.stat
dd if=/dev/zero of=/tmp/blob bs=1M count=50
grep -E '^(anon|file) ' /sys/fs/cgroup/memory.stat   # file grew by ~50 MB
cat /sys/fs/cgroup/memory.current
```
The group is now using over half its limit, almost all of it reclaimable cache.

**Step 4: Allocate too much anonymous memory.**

```bash
python3 -c 'x = b"x" * (200 * 1024 * 1024)'
echo $?                              # 137 (bash prints: Killed)
grep oom_kill /sys/fs/cgroup/memory.events   # oom_kill 1
```
The kernel reclaimed the cache first, but 200 MB of anonymous memory can't fit in 100 MB. With no swap there was nothing else to free, so python was killed.

**Step 5: Confirm from the outside.**

Exit, then run the allocation as the container's main process:
```bash
docker run --name oomtest --memory=100m --memory-swap=100m python:3.12-slim \
  python3 -c 'x = b"x" * (200 * 1024 * 1024)'
docker inspect -f '{{.State.ExitCode}} {{.State.OOMKilled}}' oomtest   # 137 true
docker rm oomtest
```

### Your turn: finish it

Inside a memory-limited container, fill in the blanks so the script prints how much of its cgroup limit is in use and how much of that is page cache.

```text
#!/bin/sh
cg=/sys/fs/cgroup
cur=$(cat $cg/memory.current)
max=$(cat $cg/___)
file=$(awk '$1 == "___" {print $2}' $cg/memory.stat)
echo "using $((cur * 100 / max))% of limit, $((file / 1048576)) MiB is page cache"
```

<details>
<summary>Answer</summary>

The blanks are `memory.max` (`max=$(cat $cg/memory.max)`) and `file` (`awk '$1 == "file" {print $2}'`). This only works when a limit is set. Without one, `memory.max` contains the word `max` and the shell arithmetic fails.

</details>

### Your turn: on your own

A container has `memory.max` = 512 MiB. Its `memory.stat` shows `anon` = 120 MiB and `file` = 360 MiB, so `memory.current` is about 490 MiB. A monitoring dashboard says it is at 96% and 'about to be OOM-killed'. Is that right? What would actually lead to an OOM kill, and which number would you watch instead?

<details>
<summary>Hint 1</summary>

Which of the two kinds of memory can the kernel free without killing anything?

</details>

<details>
<summary>Hint 2</summary>

When the limit is reached, the kernel reclaims page cache before it considers OOM.

</details>

<details>
<summary>Hint 3</summary>

Watch anonymous memory, or current minus the inactive file cache, and the `oom_kill` counter in memory.events.

</details>

<details>
<summary>Answer</summary>

The dashboard is mostly wrong. About 360 MiB is page cache, which the kernel reclaims under pressure, so the real pressure comes from the 120 MiB of anonymous memory. An OOM kill happens when the memory that can't be reclaimed (anon, plus cache that is in active use, plus kernel memory) doesn't fit in 512 MiB even after reclaim. Without swap, that means anon growing towards the limit. Watch `anon` and a 'working set' estimate (`memory.current` − `inactive_file`), and alert on `oom_kill` in `memory.events`. Chapter 16 shows that Kubernetes uses a working-set figure like this for exactly this reason.

</details>

### Explain it

In your own words: Why does Linux deliberately fill 'unused' RAM with page cache, and why is that safe inside a cgroup limit?

### Check

**1. `docker inspect` shows a container exited with code 137 and `OOMKilled: true`. What happened?**

A. The application called exit(137)
B. The kernel's OOM killer sent SIGKILL because the cgroup exceeded memory.max
C. Docker stopped it after a health-check timeout
D. The container ran out of disk space

<details>
<summary>Answer</summary>

**B.** The kernel's OOM killer sent SIGKILL because the cgroup exceeded memory.max

137 = 128 + 9 (SIGKILL), and OOMKilled=true confirms the cgroup OOM killer was responsible. Health-check failures and full disks give different signals and messages, and an app that chose exit code 137 wouldn't set OOMKilled.

</details>

**2. Which memory does the kernel reclaim first when a cgroup reaches its limit (with swap disabled)?**

A. Anonymous heap memory
B. Page cache (file-backed pages)
C. Stack memory of the largest process
D. Nothing; it kills a process immediately

<details>
<summary>Answer</summary>

**B.** Page cache (file-backed pages)

File-backed pages can be dropped or written back and read again later, so reclaiming them is safe. Without swap, anonymous memory has nowhere to go. That is why OOM happens only after reclaim fails.

</details>

**3. A process has VSZ 8 GB and RSS 200 MB. How much physical RAM is it using?**

A. About 8 GB
B. About 200 MB
C. About 8.2 GB
D. Impossible to tell

<details>
<summary>Answer</summary>

**B.** About 200 MB

VSZ is reserved address space, much of which may never be touched. RSS is what is actually resident in RAM. Shared libraries make RSS slightly overstate unique usage, but VSZ is the wrong number for capacity planning.

</details>

**Sources:** general background knowledge; no NICo docs page covers this directly.

<a id="build-task"></a>
## Build task: Containerised async inventory agent

**Goal:** Build a small Python "inventory agent" in a Git repository and run it as a non-root container under a 128 MiB memory limit. It reports the container's network interfaces (physical or virtual, with MACs) and its cgroup memory usage and limit, runs 10 simulated 1-second BMC health probes concurrently, and prints everything as JSON.

**Why it matters for NICo:** NICo is a set of services that inventory machines, talk to many BMCs and NICs at once, and run in memory-limited containers whose config lives in Git. This build is a miniature of that setup. You read NIC data from sysfs, overlap slow I/O with async, package the service as a non-root image, check its cgroup limits from inside, and track it all in Git. You will use the same skills to debug NICo's pods later.

**You need:**

- Linux or macOS with a terminal
- Git 2.28+ (`git --version`)
- Python 3.10+ on the host is optional, for testing the script locally. The verify step runs its check inside a container, so you don't need host Python for it
- Docker Engine or Docker Desktop (or Podman, using `podman` in place of `docker`)
- A cgroup v2 host. Check with `docker info | grep -i cgroup` and expect `Cgroup Version: 2`. Current Docker Desktop and modern distros use v2

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Create the repo</summary>

```bash
mkdir inventory-agent && cd inventory-agent
git init -b main
printf '__pycache__/\n' > .gitignore
git add .gitignore && git commit -m "Initial commit"
git switch -c feature/agent
```

</details>

<details>
<summary>Step 2: Write the inventory functions</summary>

Create `agent.py` with two plain (non-async) functions:

- `interfaces()` loops over `pathlib.Path("/sys/class/net").iterdir()` and returns a list of dicts with exactly these keys:
  `{"name": str, "mac": str, "kind": "physical" | "virtual"}`.
  Read `mac` from `<path>/address` with `.read_text().strip()`. `kind` is `"physical"` if `<path>/device` exists, otherwise `"virtual"`.
- `memory()` returns a dict with exactly these keys:
  `{"current": int, "max": str, "anon": int, "file": int}`.
  - `current`: `int(Path("/sys/fs/cgroup/memory.current").read_text())`
  - `max`: `Path("/sys/fs/cgroup/memory.max").read_text().strip()`. Keep it as a string because it can be the word `max`, and **strip it**, otherwise you get `"134217728\n"`.
  - `anon` and `file`: split each line of `memory.stat` into a key and a value, and take the `anon` and `file` values as ints.

Commit: `git add agent.py && git commit -m "Add NIC and memory inventory"`.

</details>

<details>
<summary>Step 3: Add concurrent async probes</summary>

Add `async def probe(name)`, which does `await asyncio.sleep(1)` and returns `{"target": name, "ok": True}`. In `async def main()`, record `time.monotonic()`, run `results = await asyncio.gather(*(probe(f"bmc-{i}") for i in range(10)))`, and work out `elapsed`. Then print one JSON document:
```python
print(json.dumps({
    "uid": os.getuid(),
    "interfaces": interfaces(),
    "memory": memory(),
    "probes": results,
    "probe_seconds": round(elapsed, 2),
}, indent=2))
```
Finish the file with `asyncio.run(main())`. You need `import asyncio, json, os, time` and `from pathlib import Path`. Commit.

</details>

<details>
<summary>Step 4: Write the Dockerfile</summary>

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY agent.py .
USER 10001
CMD ["python", "agent.py"]
```
Add a `.dockerignore` containing `.git` so your history doesn't end up in the image. Commit both files.

</details>

<details>
<summary>Step 5: Build and run under a memory limit</summary>

```bash
docker build -t inventory-agent:v1 .
docker run --rm --memory=128m --memory-swap=128m inventory-agent:v1
```
Check the output: `uid` is 10001, `eth0` and `lo` are both `virtual` (`eth0` is a veth end), `memory.max` is `"134217728"`, and `probe_seconds` is about 1.0, not 10.

</details>

<details>
<summary>Step 6: Merge and tag</summary>

```bash
git switch main
git merge feature/agent
git tag v1
git log --oneline --graph --decorate
```

</details>

**Check it works:** Run this. The second container reads the agent's JSON from stdin, so you don't need Python on the host:
```bash
docker run --rm --memory=128m --memory-swap=128m inventory-agent:v1 \
  | docker run --rm -i python:3.12-slim python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["uid"]!=0; assert d["memory"]["max"]=="134217728"; assert d["probe_seconds"]<2; assert any(i["name"]=="eth0" and i["kind"]=="virtual" for i in d["interfaces"]); print("PASS")'
```
It should print `PASS`. Then check that `git log --oneline main` shows at least 4 commits and `git tag` lists `v1`.

<details>
<summary>If you get stuck</summary>

- `probe_seconds` is about 10: you used `time.sleep` instead of `await asyncio.sleep`, or you awaited the probes in a loop instead of using `gather`.
- A `KeyError` or failed assert on `memory`/`max`: the dict keys must be exactly `current`, `max`, `anon`, `file`, and `max` must be the stripped string `"134217728"`, not `"134217728\n"` or an int.
- `FileNotFoundError: /sys/fs/cgroup/memory.max`: the host is on cgroup v1, or the container isn't using a private cgroup namespace. Try `--cgroupns=private`, or use a cgroup v2 host or VM.
- `memory.max` shows `max`: you forgot `--memory=128m` on `docker run`.
- `json.load` fails in the verify step: something else printed to stdout. Send debug output to stderr with `print(..., file=sys.stderr)`.
- Only `lo` appears: you ran with `--network none`. The default bridge network gives you `eth0`.
- `uid` is 0: the `USER 10001` line is missing, you didn't rebuild the image after adding it, or `--user`/`-u 0` was passed to `docker run`. (Its position relative to `CMD` doesn't matter.)

</details>

**Stretch goal:** Add a `--hog MB` command-line option that allocates `b"x" * (MB * 1024 * 1024)` before printing. Run it with `--hog 300` under the 128 MiB limit (without `--rm`), check with `docker inspect -f '{{.State.ExitCode}} {{.State.OOMKilled}}' <container>` that you get `137 true`, and record the experiment on a Git branch with a commit message that explains the result. For a second stretch, replace the fake probes with real `asyncio.open_connection` TCP checks against a few `python -m http.server` containers on a user-defined Docker network, using a 2-second `asyncio.wait_for` timeout for one deliberately unreachable host.

## Review notes

The draft was rewritten twice using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (Linux memory and cgroups): In the worked example's OOM step, `grep oom_kill /sys/fs/cgroup/memory.events` is shown as printing just `oom_kill 1`. On kernels that also have an `oom_group_kill` counter, the grep matches that line too, so the learner sees an extra `oom_group_kill 0` line that the text doesn't mention. *Fix:* Use `grep -w oom_kill` (or `grep '^oom_kill '`), or add a note that an `oom_group_kill 0` line may also appear.
- **minor** (build task): `interfaces()` loops over every entry in /sys/class/net and reads `<path>/address`. If the bonding module is loaded, /sys/class/net also contains `bonding_masters`, which is a plain file. Reading `address` under it fails with NotADirectoryError. *Fix:* Tell learners to skip entries that aren't directories (`if not p.is_dir(): continue`), or add a hint that names this error.

---

[← 01-hardware-basics-data-formats.md](01-hardware-basics-data-formats.md) · [03-networking-basics.md →](03-networking-basics.md)
