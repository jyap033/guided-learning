# Chapter 13: Building Images

*Part: Kubernetes & Deployment · 10 concepts · [curriculum](../curriculum.md#chapter-13)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Up to now you've treated NICo as something that already exists. You've seen its services, its DHCP/DNS/PXE stack and its DPU networking. This chapter covers how those running pieces get built. Every NICo Core service, every NICo REST service, and every OS image that a host or DPU network-boots starts as source code in the `infra-controller` repository. All of it gets compiled and packed into container images.

The chapter goes from the bottom up. First the Rust toolchain and Cargo, because NICo Core is written in Rust. Then the one-step build-host bootstrap. Then the Docker parts the build depends on: registries, BuildKit/Buildx builders, QEMU emulation for the other CPU architecture, and multi-architecture manifests. With those in hand, the `make images-dev`, `make images` and `make images-all` targets make sense. The chapter ends with boot artifacts and the DPU BFB, which are the images NICo serves to machines that don't have an OS yet. They build on the PXE/iPXE material from Chapter 12 and the BlueField material from Chapter 7.

This matters for running NICo because the Quick Start's first step is "build the containers and push them to your registry". If the build or push goes wrong, the Kubernetes deployment in the next chapters has nothing to pull. For example, an image tag might be missing its arm64 half, or images might be pushed to a registry the cluster can't reach. Knowing what each target produces, and how to check its output, saves you from debugging pods stuck pulling images.

You can try most examples on a laptop with Docker. The full NICo builds need an Ubuntu 24.04 host with about 150 GB free, and the chapter says clearly where that applies.

**By the end of this chapter you can:**

- Explain how rustup, rustc, Cargo and cargo-make fit together, and read a `cargo make` invocation from the NICo build docs
- Prepare an Ubuntu 24.04 build host with `make bootstrap` and check that the docker group, the userns sysctl and binfmt emulation are actually in effect
- Build and smoke-test a single native development image with `make images-dev`, and predict which image references a set of Make variables produces
- Explain how BuildKit builders, Docker contexts, binfmt/QEMU emulation and registries interact when building for amd64 and arm64
- Run `make images` / `make images-all` with the right architecture and registry variables, and check each tag's platforms with `docker buildx imagetools inspect`
- Describe what the boot-artifact images and the DPU BFB contain, and why a container's platform can differ from the architecture of the payload it carries

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [Rust toolchain and Cargo](#rust-toolchain-and-cargo)
2. [Build host bootstrap (make bootstrap)](#build-host-bootstrap)
3. [Container registry](#container-registry)
4. [Docker BuildKit and Buildx](#docker-buildkit-and-buildx)
5. [Building local dev images (make images-dev)](#building-local-dev-images)
6. [Cross-architecture emulation (binfmt/QEMU)](#cross-architecture-emulation)
7. [Multi-architecture image manifest](#multi-architecture-image-manifest)
8. [Building all images (make images)](#building-all-images)
9. [Boot artifacts](#boot-artifacts)
10. [DPU BFB](#dpu-bfb)
11. [Build task: Ship a multi-arch Rust image through a local registry, NICo-style](#build-task)

<a id="rust-toolchain-and-cargo"></a>
## 1. Rust toolchain and Cargo

### Before you read

- Rust comes with three commands: `rustup`, `rustc` and `cargo`. Which one would you normally run to build a project and fetch its dependencies?
- The NICo docs use both `make ...` and `cargo make ...`. Guess: are these the same tool?

<details>
<summary>Answers</summary>

- **Rust comes with three commands: `rustup`, `rustc` and `cargo`. Which one would you normally run to build a project and fetch its dependencies?** `cargo`. It reads the project manifest, downloads dependencies and calls the compiler `rustc` for you. `rustup` installs and switches toolchains. You rarely call `rustc` directly.
- **The NICo docs use both `make ...` and `cargo make ...`. Guess: are these the same tool?** No. `make` is GNU Make, which reads a `Makefile`. `cargo make` is cargo-make, a separate Rust task runner installed with `cargo install cargo-make`. It reads `Makefile.toml`.

</details>

### Explanation

NICo Core is written in Rust, so building it starts with the Rust toolchain.

- **`rustc`** is the compiler. It turns `.rs` source into a native binary for one target, such as `x86_64-unknown-linux-gnu` or `aarch64-unknown-linux-gnu`.
- **`rustup`** installs and manages toolchains: compiler versions, extra targets and components. NICo's manual setup installs it with `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`.
- **Cargo** is Rust's package manager and build tool. A project (a *crate*) is described in `Cargo.toml`, which is TOML, a format you already know. `cargo build` resolves dependencies, records their exact versions in `Cargo.lock` and compiles into `target/`. `cargo build --release` produces an optimised build in `target/release/`. A *workspace* groups many crates in one repository, and `-p <name>` picks one of them. The Quick Start's `cargo build --release -p nico-admin-cli` builds just the admin CLI, giving `target/release/nico-admin-cli`.
- **`cargo install <tool>`** compiles a Rust tool and puts it in `~/.cargo/bin`. NICo's setup runs `cargo install cargo-make cargo-cache`.

**cargo-make** is a task runner. Tasks live in a `Makefile.toml`, and you run one with `cargo make <task>`. Tasks can run commands, set environment variables and depend on other tasks. NICo uses it for Rust-centred build tasks, for example:

```sh
cargo make --cwd pxe --env SA_ENABLEMENT=1 build-boot-artifacts-bfb-sa
BUILD_CONTAINER_X86_URL="nico-buildcontainer-x86_64" cargo make build-cli
```

`--cwd pxe` runs from the `pxe/` directory, so the `Makefile.toml` there is used. `--env NAME=value` sets a variable for the tasks. The second line sets a variable through the normal shell environment instead.

The NICo build has two layers. The top-level GNU `make` targets (`make bootstrap`, `make images`, ...) are the operator-facing entry points. cargo-make tasks run Rust-specific steps inside them or alongside them. **cargo-cache** is a helper for inspecting and trimming Cargo's download cache in `~/.cargo`, which grows quickly on a build host.

**Analogy.** Cargo is like a kitchen's head chef. You hand over a recipe card (`Cargo.toml`), and the chef orders the ingredients (dependencies) and tells the line cook (`rustc`) what to do. rustup is the restaurant supply company that delivers and swaps out the chef's equipment. cargo-make is the shift checklist pinned on the wall: 'prep veg, then make stock, then plate'. The analogy breaks down because a real chef improvises. Cargo is deterministic, and `Cargo.lock` pins the exact ingredient versions so every build uses the same ones.

### Worked example: From zero to a cargo-make task on your laptop

**Step 1: Install the toolchain.**

On Linux or macOS:
```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # choose option 1
. "$HOME/.cargo/env"     # or open a new shell
rustup --version && cargo --version && rustc --version
```

**Step 2: Create and run a crate.**

```sh
cargo new hello && cd hello
cat Cargo.toml          # [package] name, version, edition
cargo run               # compiles target/debug/hello and runs it: Hello, world!
```

**Step 3: Make a release build and find the binary.**

```sh
cargo build --release
ls -l target/release/hello
file target/release/hello    # e.g. ELF 64-bit ... x86-64, or Mach-O arm64 on Apple silicon
```
The binary is native to the machine that built it. This becomes important later in the chapter.

**Step 4: Install cargo-make and add a task.**

```sh
cargo install cargo-make
cat > Makefile.toml <<'EOF'
[env]
TARGET_NAME = "world"

[tasks.greet]
command = "echo"
args = ["hello", "${TARGET_NAME}"]
EOF
cargo make greet
```
cargo-make prints its own log lines and then `hello world`.

**Step 5: Run it from another directory.**

```sh
cd ..
cargo make --cwd hello greet
```
This is the same pattern as NICo's `cargo make --cwd pxe ...`: point cargo-make at the directory whose `Makefile.toml` you want.

### Your turn: finish it

Fill in the blanks so that `cargo make shout` prints `HELLO WORLD`. Use the same `TARGET_NAME` variable as in the worked example.

```text
[env]
TARGET_NAME = "WORLD"

[tasks.___]
command = "___"
args = ["HELLO", "${TARGET_NAME}"]
```

<details>
<summary>Answer</summary>

The section header is `[tasks.shout]` and the command is `echo`. The task name comes from the `tasks.<name>` table key, and `command` is the program to run, with `args` as its arguments.

</details>

### Your turn: on your own

In the same `Makefile.toml`, add a task `all`. Running `cargo make all` should first run `cargo build --release` (as its own task called `release`) and then the `greet` task. Write the TOML for both new tasks.

<details>
<summary>Hint 1</summary>

Each task is its own `[tasks.<name>]` table. The `release` task runs the program `cargo` with two arguments.

</details>

<details>
<summary>Hint 2</summary>

cargo-make lets a task list other tasks that must run first. The key is a list of task names.

</details>

<details>
<summary>Hint 3</summary>

`[tasks.all]` needs only one line: `dependencies = [...]` with the two task names in order.

</details>

<details>
<summary>Answer</summary>

```toml
[tasks.release]
command = "cargo"
args = ["build", "--release"]

[tasks.all]
dependencies = ["release", "greet"]
```
`cargo make all` runs `release` and then `greet`.

</details>

### Explain it

In your own words: Why do you think NICo keeps top-level GNU `make` targets for operators while using cargo-make for Rust-specific tasks, rather than putting everything in one tool?

### Check

**1. How does NICo's manual setup install cargo-make?**

A. `apt-get install cargo-make`
B. `rustup component add cargo-make`
C. `cargo install cargo-make cargo-cache`
D. It ships inside rustup by default

<details>
<summary>Answer</summary>

**C.** `cargo install cargo-make cargo-cache`

Step 10 of the manual setup runs `cargo install cargo-make cargo-cache`. cargo-make isn't in the apt package list, and it isn't a rustup component. rustup components are toolchain parts such as clippy or rustfmt.

</details>

**2. After `cargo build --release -p nico-admin-cli`, where is the binary?**

A. `target/debug/nico-admin-cli`
B. `target/release/nico-admin-cli`
C. `~/.cargo/bin/nico-admin-cli`
D. `crates/admin-cli/bin/nico-admin-cli`

<details>
<summary>Answer</summary>

**B.** `target/release/nico-admin-cli`

`--release` writes to `target/release/` at the workspace root, as both the Quick Start and the build manual say. `target/debug` is for builds without `--release`. `~/.cargo/bin` is where `cargo install` puts tools, not where `cargo build` puts output.

</details>

**3. Which file does `cargo make --cwd pxe <task>` look for in the `pxe/` directory?**

<details>
<summary>Answer</summary>

`Makefile.toml`

cargo-make reads tasks from `Makefile.toml`, not from a GNU `Makefile` and not from `Cargo.toml`.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="build-host-bootstrap"></a>
## 2. Build host bootstrap (make bootstrap)

*Builds on: Rust toolchain and Cargo (ch. 13)*

### Before you read

- The docs call `make bootstrap` 'idempotent'. What does that tell you about running it a second time?
- The bootstrap adds you to the `docker` group. Will `docker ps` work in the same terminal straight afterwards, without sudo?

<details>
<summary>Answers</summary>

- **The docs call `make bootstrap` 'idempotent'. What does that tell you about running it a second time?** Running it again is safe. It brings the host to the same end state without breaking or duplicating anything, so you can re-run it to repair a host that drifted or was only half set up.
- **The bootstrap adds you to the `docker` group. Will `docker ps` work in the same terminal straight afterwards, without sudo?** Usually not. Group membership is read when you log in, so you need a new login session (or a reboot) before it applies.

</details>

### Explanation

The complete stack and boot-artifact build needs an **Ubuntu 24.04 host or VM with at least 150 GB of free disk space**, plus Git and Make. The bootstrap **does not run on macOS**. On a Mac, use `make images-dev` through a Linux Docker daemon (later lesson).

```sh
git clone git@github.com:dsx-ai-factory/infra-controller.git
cd infra-controller
make bootstrap          # or: ./scripts/setup-build-host.sh
```

`make bootstrap` runs `scripts/setup-build-host.sh`. In one idempotent step it does what the manual steps do:

1. **System packages** via apt: compilers (`build-essential`), `mkosi`, `docker.io`, `docker-buildx`, `sccache` (a compile cache), `protobuf-compiler`, assorted `-dev` libraries, `systemd-boot`, `systemd-ukify`, `jq`, `zip` and more.
2. **direnv** shell hook, then `direnv allow` in the repo. direnv loads per-directory environment variables when you `cd` in.
3. **rustup**, which provides `cargo`.
4. **Git submodules**: `git submodule update --init --recursive`, which pulls the mkosi and iPXE sources the boot-artifact build needs.
5. **Docker plus emulation**: `sudo systemctl enable --now docker.socket`, then a privileged `tonistiigi/binfmt` container that registers QEMU for other CPU architectures.
6. **Cargo tooling**: `cargo install cargo-make cargo-cache`.
7. **A sysctl drop-in**: `kernel.apparmor_restrict_unprivileged_userns=0` in `/etc/sysctl.d/99-userns.conf`. This relaxes Ubuntu's AppArmor restriction on unprivileged user namespaces.
8. **Group membership**: `sudo usermod -aG docker $(id -un)`.

Then **reboot (or log out and back in)**. Be precise about what takes effect when:

- The **docker group** applies at your next login.
- The **sysctl file** is applied at boot, or right away with `sudo sysctl --system`. Logging out alone doesn't apply it.
- **binfmt registrations** live in the running kernel and are **lost on reboot** unless something re-registers them. So after the reboot the docs recommend, check `/proc/sys/fs/binfmt_misc/` and re-run the binfmt install if the entries are gone. Re-running `make bootstrap` also works, because it's idempotent.

The point is a repeatable build host: anyone can recreate it from a fresh Ubuntu VM, which matters when you need to rebuild images months later.

**Analogy.** It's like the induction checklist at a new workshop: get your badge, collect your tools, sign the safety form. Some items work immediately, like tools in hand. Some only work after the badge system syncs overnight, like group membership at next login. And some, like a whiteboard note, are wiped every night (binfmt state at reboot). The analogy fails in one way: a workshop checklist is done once, but you can re-run the bootstrap any time.

### Worked example: Bootstrap a fresh Ubuntu 24.04 VM and confirm it worked

**Step 1: Check the host qualifies.**

```sh
. /etc/os-release && echo "$VERSION_ID"    # want 24.04
df -h .                                    # want >= 150G available
git --version && make --version | head -1
```

**Step 2: Run the bootstrap.**

```sh
git clone git@github.com:dsx-ai-factory/infra-controller.git
cd infra-controller
make bootstrap
```
It prompts for sudo where it needs root.

**Step 3: Reboot so group and sysctl changes apply.**

```sh
sudo reboot
```
A reboot covers both the new login (group) and the boot-time sysctl load. Logging out and back in only covers the group. In that case, also run `sudo sysctl --system`.

**Step 4: Verify each piece after reboot.**

```sh
id -nG | tr ' ' '\n' | grep -x docker          # in the docker group?
docker ps                                       # works without sudo?
sysctl -n kernel.apparmor_restrict_unprivileged_userns   # want 0
cargo make --version && docker buildx version
cd infra-controller && git submodule status     # a leading '-' means not initialised
ls /proc/sys/fs/binfmt_misc/                    # expect qemu-* entries
```

**Step 5: Re-register emulation if the reboot wiped it.**

If there are no `qemu-*` files, re-run the pinned install from the manual (or `make bootstrap` again):
```sh
sudo docker run --privileged --rm tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 --install all
```

### Your turn: finish it

Finish this post-bootstrap check script for an x86_64 build host. Fill each blank with a single word or filename.

```text
#!/usr/bin/env bash
set -u
command -v cargo-make >/dev/null && echo "ok cargo-make" || echo "MISSING cargo-make"
id -nG | grep -qw ___ && echo "ok docker group" || echo "MISSING docker group: log in again"
[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns)" = "0" ] && echo "ok userns" || echo "userns restricted: run sudo sysctl --system"
[ -e /proc/sys/fs/binfmt_misc/___ ] && echo "ok arm64 emulation" || echo "MISSING arm64 emulation: re-run the binfmt install"
```

<details>
<summary>Answer</summary>

The first blank is `docker`, the group name. The second is `qemu-aarch64`, the binfmt_misc entry that tonistiigi/binfmt registers for arm64 binaries on an x86_64 host.

</details>

### Your turn: on your own

Straight after `make bootstrap` finishes, without logging out, a colleague runs `docker ps` and gets `permission denied while trying to connect to the Docker daemon socket`. They also see that `sysctl -n kernel.apparmor_restrict_unprivileged_userns` still prints `1`. Explain both symptoms and the quickest fix for each that doesn't require re-running the bootstrap.

<details>
<summary>Hint 1</summary>

Ask yourself when Linux reads a user's group list, and when files in `/etc/sysctl.d` are read.

</details>

<details>
<summary>Hint 2</summary>

One is fixed by a new login session. The other is fixed by a command that reloads all sysctl config files.

</details>

<details>
<summary>Hint 3</summary>

Log out and back in (or reboot) for the group. Run `sudo sysctl --system` (or reboot) for the sysctl.

</details>

<details>
<summary>Answer</summary>

The shell's group list was set at login, before `usermod -aG docker` ran, so the session isn't in `docker` yet. Fix: log out and back in, or reboot. The sysctl change was only written to `/etc/sysctl.d/99-userns.conf`, and those files are applied at boot or by `sudo sysctl --system`. Fix: run `sudo sysctl --system`. A single reboot fixes both, but then you must check that the binfmt registrations are still present and re-run the install if not.

</details>

### Explain it

In your own words: Why is an idempotent, scripted bootstrap better for a team than a wiki page of manual steps, especially for a build that has to be repeated for every release?

### Check

**1. You only have a MacBook with Docker Desktop. What's the supported way to build a NICo image locally?**

A. Run `make bootstrap` on macOS, then `make images`
B. Use `make images-dev` through the Linux Docker daemon
C. Install Ubuntu packages with Homebrew and run `scripts/setup-build-host.sh`
D. Building NICo on a Mac isn't possible at all

<details>
<summary>Answer</summary>

**B.** Use `make images-dev` through the Linux Docker daemon

The docs say the bootstrap doesn't run on macOS and point to the local development service workflow, which needs only Git, Make and a Docker client connected to a Linux daemon. The full stack build needs an Ubuntu 24.04 host or VM.

</details>

**2. After rebooting a freshly bootstrapped host, `ls /proc/sys/fs/binfmt_misc/` shows only `register` and `status`. What happened?**

A. The bootstrap failed and must be debugged from scratch
B. binfmt registrations are runtime kernel state and were lost at reboot. Re-run the binfmt install (or `make bootstrap`).
C. The userns sysctl disabled QEMU
D. Docker deletes binfmt entries when it starts

<details>
<summary>Answer</summary>

**B.** binfmt registrations are runtime kernel state and were lost at reboot. Re-run the binfmt install (or `make bootstrap`).

The `tonistiigi/binfmt --install all` registrations aren't persistent unless something like binfmt-support or `/etc/binfmt.d` entries re-registers them at boot. That's expected, not a failure. Re-running the idempotent bootstrap or the single install command restores them.

</details>

**3. Which two Git submodules does the bootstrap pull for the boot-artifact build?**

<details>
<summary>Answer</summary>

mkosi and iPXE

The bootstrap description lists 'the mkosi/ipxe git submodules', fetched by `git submodule update --init --recursive`.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

<a id="container-registry"></a>
## 3. Container registry

*Builds on: Containers and container images (ch. 2)*

### Before you read

- In the image reference `localhost:5000/nico:latest`, which part says *which server* the image lives on?
- After `docker build -t nico .`, can a Kubernetes node on another machine run the image `nico`?

<details>
<summary>Answers</summary>

- **In the image reference `localhost:5000/nico:latest`, which part says *which server* the image lives on?** `localhost:5000`. It's the registry host and port. `nico` is the repository and `latest` is the tag.
- **After `docker build -t nico .`, can a Kubernetes node on another machine run the image `nico`?** No. The image only exists in your local Docker daemon's image store. It has to be pushed to a registry the node can reach.

</details>

### Explanation

A **container registry** is an HTTP server that stores and serves container images. Docker Hub, NGC and a self-hosted `registry:2` container all speak the same OCI Distribution API, whose paths start with `/v2/`.

The parts of an image reference, `host[:port]/path/name:tag`:

- **Registry host**: `localhost:5000`, `my-registry.example.com`. If you leave it out, Docker assumes Docker Hub.
- **Repository path**: `nico`, or `nico/nico-rest-api` when the registry setting includes a path prefix.
- **Tag**: a movable, human-friendly label such as `latest` or `v1.0.0`.
- **Digest**: `@sha256:...`, an immutable content hash. The NICo bootstrap pins `tonistiigi/binfmt` by digest for exactly this reason: a tag can be repointed, a digest can't.

`docker push` uploads an image's layers and manifest. `docker pull` downloads them. Layers are deduplicated, so pushing a second image that shares a base sends only the new layers.

**How NICo uses registries**

- `make images` pushes to `localhost:5000` by default. If you keep that default, the Makefile starts a local registry container named `nico-build-registry`.
- To publish elsewhere, set `IMAGE_REGISTRY` and usually `IMAGE_TAG`, and **authenticate Docker to that registry first** (`docker login my-registry.example.com`):
  ```sh
  make images IMAGE_REGISTRY=my-registry.example.com/nico IMAGE_TAG=v1.0.0
  ```
- `make images-dev` doesn't push at all, and `IMAGE_REGISTRY` has no effect on it.
- At deploy time, `setup.sh` reads `NICO_IMAGE_REGISTRY`. Preflight checks it has **no URL scheme** (no `https://`) and that the registry responds to an HTTPS probe. The cluster nodes need network access to it.

There's a catch with `localhost:5000`. It's "localhost" only from the build machine's point of view. A Kubernetes node that pulls `localhost:5000/nico` looks for a registry on *itself*. For a real deployment, push to a registry the cluster can reach.

Docker allows plain-HTTP registries on `127.0.0.0/8` by default, which is why a local `registry:2` works without TLS.

**Analogy.** A registry is like a parcel locker bank. `push` drops a parcel in, and `pull` collects it with the locker address (host/repo:tag). The tag is the name label on the locker door, which staff can move to another parcel. The digest is the tamper-evident seal number on the parcel itself. The analogy fails on one point: locker parcels are single objects, while registry images share layers, so 'sending' a parcel often moves only the bytes the locker doesn't already have.

### Worked example: Run a local registry and push to it

**Step 1: Start a registry.**

```sh
docker run -d --name lab-registry -p 5000:5000 registry:2
curl -s http://localhost:5000/v2/          # {} means the API is up
```

**Step 2: Tag a local image with the registry's address.**

```sh
docker pull alpine:latest
docker tag alpine:latest localhost:5000/lab/alpine:v1
```
Tagging only adds a name. It doesn't copy anything yet.

**Step 3: Push it.**

```sh
docker push localhost:5000/lab/alpine:v1
```
Note the `digest: sha256:...` line it prints.

**Step 4: Browse the registry API.**

```sh
curl -s http://localhost:5000/v2/_catalog            # {"repositories":["lab/alpine"]}
curl -s http://localhost:5000/v2/lab/alpine/tags/list  # {"name":"lab/alpine","tags":["v1"]}
```

**Step 5: Pull it back by tag and by digest.**

```sh
docker image rm localhost:5000/lab/alpine:v1
docker pull localhost:5000/lab/alpine:v1
docker pull localhost:5000/lab/alpine@sha256:<digest-from-push>
```

### Your turn: finish it

Publish your local `myapp:dev` image to the lab registry as repository `team/myapp`, tag `0.1`, then list its tags. Fill in the blanks.

```text
docker tag myapp:dev ___/team/myapp:0.1
docker ___ localhost:5000/team/myapp:0.1
curl -s http://localhost:5000/v2/team/myapp/tags/list
```

<details>
<summary>Answer</summary>

The first blank is `localhost:5000` (the registry host:port prefix that tells Docker where to push). The second is `push`.

</details>

### Your turn: on your own

You run `make images IMAGE_REGISTRY=my-registry.example.com/nico IMAGE_TAG=v1.0.0`. Write the full image reference for the NICo REST API image, and the command you must run before the build so the push succeeds. Then say what's wrong with setting `NICO_IMAGE_REGISTRY=https://my-registry.example.com/nico` for `setup.sh`.

<details>
<summary>Hint 1</summary>

The verification loop in the docs builds references as `${IMAGE_REGISTRY}/${image}:${IMAGE_TAG}`.

</details>

<details>
<summary>Hint 2</summary>

The REST API image is named `nico-rest-api`. Pushing to a private registry needs credentials.

</details>

<details>
<summary>Hint 3</summary>

Preflight checks that the registry value has no URL scheme.

</details>

<details>
<summary>Answer</summary>

The reference is `my-registry.example.com/nico/nico-rest-api:v1.0.0`. Before building, run `docker login my-registry.example.com` (or the equivalent for your registry). `NICO_IMAGE_REGISTRY` must not include `https://`: image references never have a scheme, and preflight explicitly checks for this. Use `my-registry.example.com/nico`.

</details>

### Explain it

In your own words: Why does pushing to the default `localhost:5000` work fine for checking a build but fail as the registry for a multi-node Kubernetes deployment?

### Check

**1. What does the NICo Makefile do when you build with the default registry setting?**

A. Pushes to Docker Hub under your username
B. Starts a local registry named `nico-build-registry` and pushes to `localhost:5000`
C. Keeps images only in the local daemon and never pushes
D. Asks for an NGC API key

<details>
<summary>Answer</summary>

**B.** Starts a local registry named `nico-build-registry` and pushes to `localhost:5000`

The docs say images are pushed to `localhost:5000` by default and the Makefile starts `nico-build-registry` for that default. Not pushing at all is the behaviour of `make images-dev`, not `make images`.

</details>

**2. Why does the NICo bootstrap reference `tonistiigi/binfmt@sha256:400a...` instead of `tonistiigi/binfmt:latest`?**

A. Digests download faster than tags
B. A digest is immutable, so every build host runs exactly the same image
C. Tags don't work with `--privileged`
D. Docker Hub requires digests for privileged images

<details>
<summary>Answer</summary>

**B.** A digest is immutable, so every build host runs exactly the same image

Tags can be moved to new content at any time, and digests can't. Pinning makes a privileged, kernel-modifying step reproducible. Speed and privilege mode have nothing to do with it.

</details>

**3. Which variable changes where `make images-dev` writes its output image?**

A. `IMAGE_REGISTRY`
B. `DEV_IMAGE`
C. `NICO_ARCHES`
D. `BUILDX_BUILDER`

<details>
<summary>Answer</summary>

**B.** `DEV_IMAGE`

`make images-dev` doesn't push, and the docs say `IMAGE_REGISTRY` doesn't affect it. The output reference is `DEV_IMAGE`, which defaults to `nico-dev-$(DEV_TARGET):$(IMAGE_TAG)`.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="docker-buildkit-and-buildx"></a>
## 4. Docker BuildKit and Buildx

*Builds on: Containers and container images (ch. 2)*

### Before you read

- You build image `base:1` and then build a second Dockerfile that starts `FROM base:1`, without pushing anything. Will the second build always find `base:1`?

<details>
<summary>Answers</summary>

- **You build image `base:1` and then build a second Dockerfile that starts `FROM base:1`, without pushing anything. Will the second build always find `base:1`?** Not always. It depends on which builder runs the second build. A builder with its own separate store, such as a `docker-container` Buildx builder, can't see images in your daemon and will try to pull `base:1` from Docker Hub.

</details>

### Explanation

**BuildKit** is the engine that executes Dockerfiles. It builds a graph of stages, runs independent stages in parallel and caches each step. It also supports features such as `RUN --mount=type=cache`, a cache directory that persists between builds; Rust Dockerfiles commonly use it to keep Cargo caches warm. (The NICo docs say only that repeated `images-dev` builds reuse Docker layers and Cargo caches, kept separate per architecture. They don't say which mechanism the recipes use.) **Buildx** is the Docker CLI plugin that drives BuildKit: `docker buildx build`, `docker buildx ls`, `docker buildx imagetools`. On current Docker Engine, plain `docker build` is an alias for Buildx.

Two concepts decide *where* a build runs:

- **Docker context**: which Docker daemon the CLI talks to (`docker context ls`, `docker context show`). You can select one per command with the `DOCKER_CONTEXT` environment variable.
- **Buildx builder**: which BuildKit instance runs the build (`docker buildx ls`). You can select one with `BUILDX_BUILDER`. Every context has a built-in builder using the **`docker` driver**, named after the context (`default`, or `desktop-linux` on Docker Desktop). It builds straight into that daemon's image store. You can also create builders with the **`docker-container` driver**. These run BuildKit in a container with its own cache and store. Results don't appear in `docker image ls` unless you `--load` them or `--push` them to a registry.

The builder also determines **which platforms** you can build. `docker buildx ls` lists them. Non-native platforms appear only when emulation is set up (next lessons).

**Why NICo pins both.** `make images-dev` builds a chain: compiler image → runtime image → service image, where later builds use earlier ones by name. The recipe captures the active Docker context *once* and sets it in both `DOCKER_CONTEXT` and `BUILDX_BUILDER`. This keeps the architecture check and every build on that context's built-in builder and image store, even when Docker aliases builds to Buildx. Custom Buildx builders are **not** used, so the intermediate images stay visible to the next build without a registry. If one step ran on a `docker-container` builder, the service build would fail to find `nico-dev-build`.

The full `make images` flow also relies on the builder: 'building the non-native architecture uses the platforms configured on the active Docker Buildx builder.'

**Analogy.** The Docker context is which kitchen you're in, and the builder is which cook you hand the recipe to. The built-in cook works off the kitchen's shared shelves (the daemon image store). A `docker-container` cook has a private pantry, so dishes they make don't appear on the shared shelves unless they're plated out (`--load`) or shipped (`--push`). The analogy is imperfect: real cooks can walk over and look at shared shelves, but an isolated builder genuinely can't see the daemon's images.

### Worked example: See builders, then watch an isolated builder lose an intermediate image

**Step 1: Inspect contexts and builders.**

```sh
docker context show        # e.g. default or desktop-linux
docker buildx ls           # the built-in builder has DRIVER docker; note its PLATFORMS
```

**Step 2: Build a base image with the built-in builder.**

```sh
mkdir -p bk-demo && cd bk-demo
printf 'FROM alpine:latest\nRUN echo base > /base.txt\n' > Dockerfile.base
printf 'FROM lab-base:1\nRUN cat /base.txt\n' > Dockerfile.app
docker build -f Dockerfile.base -t lab-base:1 .
docker image ls lab-base
```

**Step 3: Chain a second build on the same builder.**

```sh
docker build -f Dockerfile.app -t lab-app:1 .   # succeeds: lab-base:1 is in the daemon store
```

**Step 4: Try the chain on an isolated builder.**

```sh
docker buildx create --name iso --driver docker-container
docker buildx build --builder iso -f Dockerfile.app -t lab-app:2 .
```
This fails while resolving `docker.io/library/lab-base:1`, because the isolated BuildKit can't see the daemon's images and looks on Docker Hub instead.

**Step 5: Clean up.**

```sh
docker buildx rm iso
```
This is the problem NICo's recipe avoids by pinning `DOCKER_CONTEXT` and `BUILDX_BUILDER` to the built-in builder.

### Your turn: finish it

Write the shell lines that pin every later `docker` and `docker buildx` command in a script to the current context and its built-in builder, the way the NICo recipe does.

```text
ctx="$(docker context ___)"
export DOCKER_CONTEXT="$ctx"
export BUILDX_BUILDER="___"
```

<details>
<summary>Answer</summary>

The first blank is `show` (`docker context show` prints the active context name). The second is `$ctx`: the built-in builder of a context has the same name as the context, so `BUILDX_BUILDER` gets the captured value.

</details>

### Your turn: on your own

A teammate set `docker buildx use mybuilder` (a `docker-container` builder) months ago and forgot. Their own script builds `nico-dev-build:latest` and then a service image `FROM nico-dev-build:latest`, and it fails with 'pull access denied for nico-dev-build'. Explain the failure and give two ways to fix it.

<details>
<summary>Hint 1</summary>

Where does an image built by a `docker-container` builder go if you don't add an output flag?

</details>

<details>
<summary>Hint 2</summary>

One fix changes which builder runs the builds. The other makes the first result visible to the second build.

</details>

<details>
<summary>Hint 3</summary>

Switch back to the context's built-in builder (`docker buildx use default`, or set `BUILDX_BUILDER`), or add `--load` (or push to a registry) after the first build.

</details>

<details>
<summary>Answer</summary>

The `docker-container` builder keeps results in its own store, so `nico-dev-build:latest` never reached the daemon. The second build then tried to pull it from Docker Hub. Fix 1: run both builds on the built-in builder (`docker buildx use default`, or `BUILDX_BUILDER=<context name>` as NICo's recipe does). Fix 2: `--load` the first image into the daemon, or push it to a registry and reference it there. NICo's `make images-dev` pins the context and builder for you and doesn't use custom builders, so it isn't affected by this setting.

</details>

### Explain it

In your own words: Why does capturing the Docker context *once* at the start of a recipe matter, instead of letting each command use whatever context is active when it runs?

### Check

**1. Which statement about BuildKit and Buildx is right?**

A. Buildx is a separate container runtime that replaces Docker
B. BuildKit is the build engine, and Buildx is the CLI front end that drives it
C. BuildKit is only used for multi-arch builds
D. Buildx and BuildKit are two names for the same binary

<details>
<summary>Answer</summary>

**B.** BuildKit is the build engine, and Buildx is the CLI front end that drives it

BuildKit executes builds. Buildx is the `docker buildx` plugin that selects builders and starts builds. Neither replaces the container runtime, and BuildKit handles single-arch builds too.

</details>

**2. Why does `make images-dev` avoid custom Buildx builders?**

A. Custom builders can't build Rust
B. Custom builders are slower to start
C. Its later builds use earlier intermediate images by name, so they must share the context's built-in builder and image store without a registry
D. Custom builders always enable QEMU, which `images-dev` forbids

<details>
<summary>Answer</summary>

**C.** Its later builds use earlier intermediate images by name, so they must share the context's built-in builder and image store without a registry

The docs say pinning to the built-in builder keeps intermediate images available to the following service build without a registry. Language support and start-up time aren't the issue, and custom builders don't enable QEMU automatically.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

<a id="building-local-dev-images"></a>
## 5. Building local dev images (make images-dev)

*Builds on: Docker BuildKit and Buildx (ch. 13), Build host bootstrap (make bootstrap) (ch. 13)*

### Before you read

- Guess: does `make images-dev DEV_TARGET=dhcp` push anything to a registry or deploy anything?
- On an Apple-silicon Mac with Docker Desktop, which platform will `make images-dev` build for?

<details>
<summary>Answers</summary>

- **Guess: does `make images-dev DEV_TARGET=dhcp` push anything to a registry or deploy anything?** No. It builds three images in the selected Docker daemon (compiler, common runtime and `nico-dev-dhcp:latest`), and that's all. It doesn't push, create a registry, load into kind or deploy.
- **On an Apple-silicon Mac with Docker Desktop, which platform will `make images-dev` build for?** `linux/arm64`. It reads the daemon's architecture from `docker info` and builds natively.

</details>

### Explanation

`make images-dev` builds **one native NICo Core development service image** using the same recipes as the Tilt dev environment. It's the fastest way to build and test a single service. You need only Git, Make and a Docker client connected to a **Linux AMD64 or ARM64 daemon that supports BuildKit**. The Rust compiler and runtime dependencies are built inside containers, so you don't need rustup on the host. That's why this works from a Mac.

```sh
make images-dev DEV_TARGET=dhcp
```

This produces three images in the daemon: a compiler image (`nico-dev-build:latest`), a common runtime image (`nico-dev-runtime:latest`) and the service (`nico-dev-dhcp:latest`). Repeated builds reuse Docker layers and Cargo caches. The caches are kept separate per architecture.

**Architecture.** The target reads `docker info` and maps `amd64`/`x86_64` → `linux/amd64` and `arm64`/`aarch64` → `linux/arm64`. Any other OS or architecture is rejected before building. It **ignores `NICO_ARCHES`** and **never enables emulation**. It pins the context and the built-in builder as described in the previous lesson.

**Variables** (`NAME=value` on the make command line):

| Variable | Default |
|---|---|
| `DEV_TARGET` | `api`. Exactly one of `api`, `bmc-proxy`, `dhcp`, `machine-a-tron`, `ssh-console`, `mat-protocol-gateway`, `nico-postgres-exporter` |
| `IMAGE_TAG` | `latest` |
| `DEV_IMAGE` | `nico-dev-$(DEV_TARGET):$(IMAGE_TAG)` |
| `DEV_BUILD_CONTAINER` | `nico-dev-build:$(IMAGE_TAG)` |
| `DEV_RUNTIME_CONTAINER` | `nico-dev-runtime:$(IMAGE_TAG)` |

Explicit references win over the defaults. Changing `IMAGE_TAG` doesn't rewrite a reference you set yourself. `IMAGE_REGISTRY` does nothing here.

**Smoke test for DHCP.** The DHCP image packages the Kea DHCPv4 and DHCPv6 servers with the NICo hook at `/usr/lib/kea/hooks/libdhcp.so`, plus `iproute2` and `curl`. Check it with:

```sh
dev/docker/tests/smoke_dhcp_image.sh nico-dev-dhcp:latest
```

It takes exactly one image reference (pass your `DEV_IMAGE` if you overrode it). Wrong arguments exit with status 2. It runs a throwaway `--network none` container, checks `ip`, `ss` and `curl`, starts each Kea server with the hook, verifies UDP listeners on IPv4 port 67 and IPv6 port 547, prints a success line per address family, and returns nonzero on any failure. It doesn't test lease allocation.

These dev images are separate from the full `make images` stack build.

**Analogy.** It's like a single test bake in your own oven before the big catering order. You use the same recipe as the catering kitchen, in your own oven only, with nothing delivered. The analogy breaks down slightly: unlike a test bake, the dev build also makes its own 'oven' first (the compiler and runtime images) and then reuses it next time.

### Worked example: Build and smoke-test the DHCP dev image

**Step 1: Confirm the daemon is Linux and a supported architecture.**

```sh
docker info --format '{{.OSType}} {{.Architecture}}'   # e.g. linux x86_64, or linux aarch64
```

**Step 2: Get the repo.**

```sh
git clone git@github.com:dsx-ai-factory/infra-controller.git
cd infra-controller
make help        # lists the targets, including images-dev
```

**Step 3: Build the DHCP service.**

```sh
make images-dev DEV_TARGET=dhcp
```
The first run is slow because the Cargo caches are cold. Later runs reuse layers and caches.

**Step 4: See what was produced.**

```sh
docker image ls | grep -E 'nico-dev-(build|runtime|dhcp)'
```
There are three images, all tagged `latest`. Nothing was pushed.

**Step 5: Run the smoke test and check the exit status.**

```sh
dev/docker/tests/smoke_dhcp_image.sh nico-dev-dhcp:latest; echo "exit=$?"
```
Expect one success line for IPv4 and one for IPv6, then `exit=0`. Running the script with no argument prints usage and exits with 2.

### Your turn: finish it

Build the DHCP image tagged `pr42` instead of `latest`, then smoke-test exactly that image. Fill in the blanks.

```text
make images-dev DEV_TARGET=___ IMAGE_TAG=pr42
dev/docker/tests/smoke_dhcp_image.sh ___
```

<details>
<summary>Answer</summary>

The first blank is `dhcp`. The second is `nico-dev-dhcp:pr42`, because with no explicit `DEV_IMAGE` the output is `nico-dev-$(DEV_TARGET):$(IMAGE_TAG)`.

</details>

### Your turn: on your own

Predict the outcome of each command. (a) `make images-dev DEV_TARGET=bmc-proxy IMAGE_TAG=t1 DEV_IMAGE=lab/bmcp:x`: list the three image references it builds. (b) `make images-dev DEV_TARGET=dns`. (c) `make images-dev NICO_ARCHES=arm64` on an x86_64 daemon.

<details>
<summary>Hint 1</summary>

Explicit references beat defaults, and `IMAGE_TAG` only feeds the defaults you didn't override.

</details>

<details>
<summary>Hint 2</summary>

Check `DEV_TARGET` against its allowed list.

</details>

<details>
<summary>Hint 3</summary>

Ask whether `images-dev` reads `NICO_ARCHES` at all, and whether it ever emulates.

</details>

<details>
<summary>Answer</summary>

(a) `nico-dev-build:t1`, `nico-dev-runtime:t1` and `lab/bmcp:x`. The explicit `DEV_IMAGE` isn't rewritten by `IMAGE_TAG`. (b) It's rejected, because `dns` isn't one of the allowed `DEV_TARGET` values. (c) It builds the default `api` service for `linux/amd64`, the daemon's native architecture. `images-dev` ignores `NICO_ARCHES` and doesn't use emulation.

</details>

### Explain it

In your own words: Why is it useful for the dev image workflow to refuse emulation and always build for the daemon's own architecture?

### Check

**1. You ran `make images-dev DEV_TARGET=dhcp DEV_IMAGE=me/dhcp:try`. Which smoke-test command is correct?**

A. `dev/docker/tests/smoke_dhcp_image.sh`
B. `dev/docker/tests/smoke_dhcp_image.sh nico-dev-dhcp:latest`
C. `dev/docker/tests/smoke_dhcp_image.sh me/dhcp:try`
D. `dev/docker/tests/smoke_dhcp_image.sh me/dhcp:try nico-dev-dhcp:latest`

<details>
<summary>Answer</summary>

**C.** `dev/docker/tests/smoke_dhcp_image.sh me/dhcp:try`

The script needs exactly one image reference available in the daemon. Use the value of `DEV_IMAGE` if you overrode it. No argument or two arguments print usage and exit with 2, and `nico-dev-dhcp:latest` wasn't built in this run.

</details>

**2. What does a passing DHCP smoke test prove?**

A. Hosts can get leases from the DHCP service
B. The image's tools are present, the Kea servers start with the NICo hook, and they listen on UDP 67 (IPv4) and 547 (IPv6)
C. IPv6 is enabled in the deployment
D. The image was pushed to localhost:5000

<details>
<summary>Answer</summary>

**B.** The image's tools are present, the Kea servers start with the NICo hook, and they listen on UDP 67 (IPv4) and 547 (IPv6)

The docs say lease allocation and instance connectivity need separate lifecycle validation, and that building the DHCPv6 binary doesn't enable IPv6 in a deployment. Nothing is pushed.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

<a id="cross-architecture-emulation"></a>
## 6. Cross-architecture emulation (binfmt/QEMU)

*Builds on: Docker BuildKit and Buildx (ch. 13), CPU architectures (amd64 vs arm64) (ch. 1)*

### Before you read

- On an x86_64 Linux laptop with no special setup, what happens when you run `docker run --rm --platform linux/arm64 alpine uname -m`?

<details>
<summary>Answers</summary>

- **On an x86_64 Linux laptop with no special setup, what happens when you run `docker run --rm --platform linux/arm64 alpine uname -m`?** It typically fails with an `exec format error`, because the kernel can't execute arm64 machine code. With QEMU registered through binfmt_misc, it prints `aarch64`.

</details>

### Explanation

In Chapter 1 you saw that amd64 and arm64 CPUs run different machine code. A binary built for one won't execute on the other. NICo needs images for both, because control-plane nodes can be either and DPUs are arm64.

**binfmt_misc** is a Linux kernel feature that says 'when asked to execute a file whose header looks like X, run it with interpreter Y instead'. **QEMU user-mode emulation** (`qemu-aarch64`, `qemu-x86_64`, ...) is such an interpreter. It translates foreign instructions to native ones as the program runs. Together they make foreign binaries run transparently. That includes inside containers, which is what lets Docker build and run arm64 images on an x86 host.

The registrations appear as files under `/proc/sys/fs/binfmt_misc/`. NICo's bootstrap creates them with:

```sh
sudo docker run --privileged --rm tonistiigi/binfmt@sha256:400a... --install all
```

Facts to keep straight:

- **It's runtime kernel state.** Reboots wipe it unless something re-registers it, such as qemu-user-static with binfmt-support, or `/etc/binfmt.d` entries. After a reboot, check the directory and re-run the install if needed.
- **It's slow.** Every instruction is translated, and compiling Rust under emulation is many times slower than compiling natively.
- **It's per host.** Docker Desktop on macOS ships emulation inside its Linux VM, so you don't run this there.

**How NICo uses it**

- `make images` / `make images-all` build both architectures by default. The non-native one 'uses the platforms configured on the active Docker Buildx builder', which in practice means emulation on a single-architecture host.
- The **`-arm` targets** (`images-arm`, `images-all-arm`, `images-bfb-arm`, `images-machine-validation-arm`) need an ARM64 Docker host and stop before building on any other architecture. They **don't use QEMU or binfmt** because everything is native.
- `make images-dev` never enables emulation.

**Analogy.** binfmt_misc plus QEMU is like a phone line that automatically patches in a live interpreter whenever the caller speaks a language you don't. You keep talking normally and it just works, only slower. The analogy is imperfect in one way: human interpreters remember the arrangement, but this one is forgotten every time the phone (kernel) restarts.

### Worked example: Turn emulation on and look at what it registers (Linux)

**Step 1: Check the current state.**

```sh
uname -m                                   # x86_64
ls /proc/sys/fs/binfmt_misc/               # maybe only 'register' and 'status'
docker run --rm --platform linux/arm64 alpine uname -m   # exec format error if not set up
```

**Step 2: Register QEMU interpreters.**

```sh
sudo docker run --privileged --rm tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 --install all
```

**Step 3: Inspect a registration.**

```sh
ls /proc/sys/fs/binfmt_misc/ | grep qemu
cat /proc/sys/fs/binfmt_misc/qemu-aarch64   # shows 'enabled', the interpreter path, flags and the ELF magic it matches
```

**Step 4: Run a foreign image.**

```sh
docker run --rm --platform linux/arm64 alpine uname -m   # aarch64
docker buildx ls                                          # linux/arm64 now appears in the builder's PLATFORMS
```

**Step 5: Feel the cost.**

```sh
time docker run --rm --platform linux/amd64 alpine sh -c 'i=0; while [ $i -lt 300000 ]; do i=$((i+1)); done'
time docker run --rm --platform linux/arm64 alpine sh -c 'i=0; while [ $i -lt 300000 ]; do i=$((i+1)); done'
```
The emulated run is noticeably slower. Scale that up to a full Rust build.

### Your turn: finish it

Finish this check-and-repair snippet for an x86_64 build host after a reboot.

```text
if [ ! -e /proc/sys/fs/binfmt_misc/___ ]; then
  sudo docker run --privileged --rm tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 --install ___
fi
docker run --rm --platform linux/arm64 alpine uname -m
```

<details>
<summary>Answer</summary>

The first blank is `qemu-aarch64` (the arm64 interpreter entry). The second is `all`, matching the bootstrap's `--install all`. The last line should print `aarch64`.

</details>

### Your turn: on your own

Two engineers need the full arm64 stack. Alice has an x86_64 Ubuntu build host and runs `make images-all-arm`. Bob has an ARM64 Ubuntu build host and runs the same target. Predict what happens for each, and say whether QEMU is involved.

<details>
<summary>Hint 1</summary>

Read what the `-arm` targets require of the Docker host.

</details>

<details>
<summary>Hint 2</summary>

Do the `-arm` targets ever fall back to emulation?

</details>

<details>
<summary>Hint 3</summary>

One build stops before building. The other builds natively with no binfmt use.

</details>

<details>
<summary>Answer</summary>

Alice's build stops before building anything, because the `-arm` targets require an ARM64 Docker host and refuse other architectures. Bob's build runs natively and produces the 13 ARM64 outputs. No QEMU or binfmt is involved in either case. If Alice wants arm64 images, she would use the non-`-arm` targets (for example `make images-all`), which build the non-native architecture through the builder's emulated platforms.

</details>

### Explain it

In your own words: Why do you think NICo offers separate native `-arm` targets even though emulation can already build arm64 images on an x86 host?

### Check

**1. After a reboot, `docker run --platform linux/arm64 alpine uname -m` fails with `exec format error`, though it worked yesterday. Most likely cause?**

A. The alpine image lost its arm64 variant
B. The binfmt_misc QEMU registrations were lost at reboot
C. The docker group membership expired
D. The userns sysctl reset

<details>
<summary>Answer</summary>

**B.** The binfmt_misc QEMU registrations were lost at reboot

binfmt registrations from `tonistiigi/binfmt --install` are kernel runtime state. Check `/proc/sys/fs/binfmt_misc/` and re-run the install. Group membership would give a permission error, not exec format, and the alpine image still has its arm64 variant.

</details>

**2. Which target never uses emulation, whatever host it runs on?**

A. `make images`
B. `make images-all`
C. `make images-dev`
D. `make images-machine-lifecycle`

<details>
<summary>Answer</summary>

**C.** `make images-dev`

`images-dev` always builds for the daemon's native architecture and doesn't enable cross-architecture emulation. The `-arm` targets also avoid it. `images` and `images-all` build both architectures by default, so one of them is emulated on a single-architecture host.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

<a id="multi-architecture-image-manifest"></a>
## 7. Multi-architecture image manifest

*Builds on: Container registry (ch. 13)*

### Before you read

- `docker pull alpine:latest` on an Apple-silicon Mac and on an x86 Linux server: do both download the same image bytes?

<details>
<summary>Answers</summary>

- **`docker pull alpine:latest` on an Apple-silicon Mac and on an x86 Linux server: do both download the same image bytes?** No. The tag points to an index listing one image per platform, and each client pulls the entry matching its own architecture.

</details>

### Explanation

A single-platform image is described by an **image manifest**: a JSON document listing a config blob and the layer blobs, all addressed by digest. A **multi-architecture image** adds one level above that: an **image index** (Docker calls it a *manifest list*). The index is a JSON document whose `manifests` array has one entry per image. Each entry has a digest and a `platform` (`os`, `architecture`, sometimes `variant`). A tag such as `nico:latest` points at the index. When you pull it, the client picks the entry matching its platform.

Indexes can also contain non-runnable entries, for example BuildKit provenance attestations, whose platform is `unknown/unknown`. That's why NICo's verification loop keeps only `select(.os == "linux")` entries before comparing.

Useful commands:

```sh
docker buildx imagetools inspect alpine:latest          # human summary
docker buildx imagetools inspect --raw alpine:latest | jq .  # the raw index JSON
docker buildx imagetools create -t REPO:TAG SRC1 SRC2   # assemble an index from existing images
```

**How NICo does it.** Each architecture is built **separately**, producing `-amd64` and `-arm64` service tags (and architecture-specific Core base images). Then the bare multi-arch tag is assembled from them. The docs give the reason: this matches CI, and it's required for the REST Dockerfiles. A single combined Buildx invocation 'would reuse one builder stage and could copy an amd64 binary into the arm64 image'. That result is an image *labelled* arm64 that contains x86 code, which only fails when it runs on the wrong machine.

A single-architecture build still produces a **valid tag** whose index has just one entry. That's why `NICO_ARCHES=amd64` works for deploy as long as your nodes are amd64.

**Analogy.** An image index is like a restaurant menu that lists the same dish in 'regular' and 'gluten-free' versions. You order 'the lasagne', and the kitchen gives you the version that fits you. It breaks down because the client chooses silently and strictly. If the menu has no version matching your platform, you get an error, not a substitute.

### Worked example: Read an index, then assemble your own

**Step 1: Inspect a public multi-arch tag.**

```sh
docker buildx imagetools inspect alpine:latest
```
You'll see `MediaType: application/vnd.oci.image.index.v1+json` (or a Docker manifest list) and one `Platform:` per entry.

**Step 2: Extract the platforms the way NICo's loop does.**

```sh
docker buildx imagetools inspect --raw alpine:latest | \
  jq -r '[.manifests[].platform | select(.os == "linux") | "\(.os)/\(.architecture)"] | unique | sort | join(",")'
```
You get a comma-separated list such as `linux/386,linux/amd64,linux/arm,...`.

**Step 3: Push two single-arch images to a local registry.**

Use the `lab-registry` from the registry lesson.
```sh
for a in amd64 arm64; do
  docker pull --platform linux/$a alpine:latest
  docker tag alpine:latest localhost:5000/demo:latest-$a
  docker push localhost:5000/demo:latest-$a
done
```
If your Docker uses the containerd image store, `docker push` may push the whole index. In that case, check with `imagetools inspect` that each `-<arch>` tag has the platform you expect.

**Step 4: Assemble the bare tag.**

```sh
docker buildx imagetools create -t localhost:5000/demo:latest \
  localhost:5000/demo:latest-amd64 localhost:5000/demo:latest-arm64
docker buildx imagetools inspect localhost:5000/demo:latest
```

### Your turn: finish it

Complete the jq filter so it prints `linux/amd64,linux/arm64` for the `demo:latest` tag you assembled.

```text
docker buildx imagetools inspect --raw localhost:5000/demo:latest | \
  jq -r '[.___[].platform | select(.os == "linux") | "\(.os)/\(.___)"] | unique | sort | join(",")'
```

<details>
<summary>Answer</summary>

The first blank is `manifests` (the index's array of per-platform entries). The second is `architecture` (the field inside each entry's `platform` object).

</details>

### Your turn: on your own

A teammate 'optimises' a REST service build by replacing the two per-architecture builds with one `docker buildx build --platform linux/amd64,linux/arm64 ...`. The tag's index looks perfect, with both platforms listed, but the arm64 pods crash with `exec format error`. Explain what probably happened and how NICo's approach prevents it.

<details>
<summary>Hint 1</summary>

The index only records what each entry *claims*. It doesn't check the bytes inside.

</details>

<details>
<summary>Hint 2</summary>

Re-read the docs' reason for building each architecture separately.

</details>

<details>
<summary>Hint 3</summary>

A shared builder stage can produce one binary that gets copied into both platform images.

</details>

<details>
<summary>Answer</summary>

In a combined invocation, the REST Dockerfile's builder stage was reused, so the amd64 binary was copied into the arm64 image as well. The index correctly lists `linux/arm64`, but that image holds x86 code, so it fails with `exec format error` on arm64 nodes. NICo builds each architecture in its own invocation, producing `-amd64` and `-arm64` tags, and only then assembles the bare tag, so each image gets a binary built for its own platform.

</details>

### Explain it

In your own words: Why does the verification loop filter to `os == "linux"` entries before comparing platform lists, and what would go wrong without that filter?

### Check

**1. You build with `NICO_ARCHES=amd64`. What does the bare `nico:latest` tag look like?**

A. It's missing, because the bare tag is only created for two architectures
B. A valid tag whose index has one `linux/amd64` entry
C. Only `nico:latest-amd64` exists
D. An index with an empty arm64 placeholder

<details>
<summary>Answer</summary>

**B.** A valid tag whose index has one `linux/amd64` entry

The docs say a single-architecture build still produces a valid tag at `$(IMAGE_TAG)`, and the multi-arch manifest has one entry.

</details>

**2. Why does NICo build amd64 and arm64 in separate invocations before assembling the tag?**

A. Registries reject indexes created in one push
B. A single combined Buildx invocation could reuse one builder stage and copy an amd64 binary into the arm64 image
C. Buildx can't build two platforms at once
D. To save disk space

<details>
<summary>Answer</summary>

**B.** A single combined Buildx invocation could reuse one builder stage and copy an amd64 binary into the arm64 image

That's the documented reason, and it also matches CI. Buildx *can* build several platforms in one invocation, which is exactly what causes the stage-reuse problem for the REST Dockerfiles.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

<a id="building-all-images"></a>
## 8. Building all images (make images)

*Builds on: Multi-architecture image manifest (ch. 13), Build host bootstrap (make bootstrap) (ch. 13), Docker BuildKit and Buildx (ch. 13)*

### Before you read

- How many images do you think `make images` publishes, and does it include the OS images that hosts network-boot?

<details>
<summary>Answers</summary>

- **How many images do you think `make images` publishes, and does it include the OS images that hosts network-boot?** 11 images: NICo Core (`nico`) plus 10 REST service images. Boot artifacts and machine-validation come only with `make images-all`.

</details>

### Explanation

Once the bootstrap has run, these top-level targets build and push the deployable images:

| Command | Builds |
|---|---|
| `make images` | The 11-image deployable stack: NICo Core `nico` plus `nico-rest-api`, `nico-rest-workflow`, `nico-rest-site-manager`, `nico-rest-site-agent`, `nico-rest-db`, `nico-rest-cert-manager`, `nico-flow`, `nico-psm`, `nico-nsm`, `nico-mcp` |
| `make images-arm` | That stack for ARM64, natively on an ARM64 host |
| `make images-all` | The stack plus `machine-validation`, `boot-artifacts-x86_64` and `boot-artifacts-aarch64` (14 images) |
| `make images-all-arm` | 13 native ARM64 outputs. Omits `boot-artifacts-x86_64` |

The individual targets they wrap are `images-core`, `images-rest`, `images-machine-validation`, `images-machine-validation-arm`, `images-boot-artifacts`, `images-bfb` and `images-bfb-arm` (`make help` lists them). `make images-machine-lifecycle` is a separate QA image that isn't part of `images-all`.

**Where and what**: `IMAGE_REGISTRY` (default `localhost:5000`) and `IMAGE_TAG` (default `latest`). Log in to non-default registries first.

**Which architectures** (default `amd64 arm64` for each group):

- `NICO_ARCHES`: control-plane images (`images-base`, `images-core`, `images-rest`, `images-machine-validation`)
- `BOOT_ARTIFACTS_ARCHES`: the x86 boot-artifact image
- `DPU_ARCHES`: the DPU BFB image

`images-arm` sets `NICO_ARCHES=arm64`. `images-all-arm` sets `NICO_ARCHES=arm64` and `DPU_ARCHES=arm64`. Values other than `amd64`/`arm64` fail fast. `images-machine-validation` requires `NICO_ARCHES` to include `amd64`, because its local-only `machine-validation-runner` intermediate is amd64 and depends on the amd64 Core runtime base. Use `images-machine-validation-arm` for native ARM64.

```sh
make images-all NICO_ARCHES=amd64 DPU_ARCHES=arm64
make images IMAGE_REGISTRY=my-registry.example.com/nico IMAGE_TAG=v1.0.0
```

**Verify** with the loop in the build manual. For each image it reads `${IMAGE_REGISTRY}/${image}:${IMAGE_TAG}` with `docker buildx imagetools inspect --raw`, works out the expected platforms from the right `*_ARCHES` variable, and prints `PASS` or exits on the first `FAIL`. Set the same registry, tag and arch variables you gave `make`, and set `ARM_ONLY=1` after `images-all-arm`. Expect 14 PASS lines after `images-all` and 13 after `images-all-arm`. The loop lists all 14 images, so after plain `make images` it fails at `machine-validation`, the first image `make images` didn't build.

Budget for size: the full workflow needs about 150 GB of disk, and the three boot/validation images need the full mkosi + Rust toolchain.

**Analogy.** `make images-all` is like a print shop running a full catalogue job. Each product is printed in two paper sizes (architectures), each size is run separately, and then they're bound into one catalogue entry per product. The verification loop is the final proofread against the order sheet. The analogy breaks down because the order sheet here is three separate variables, so one product can be ordered in different sizes from the others.

### Worked example: Build everything for a private registry and verify it

**Step 1: Authenticate.**

```sh
docker login my-registry.example.com
```

**Step 2: Build and push.**

```sh
cd infra-controller
make images-all IMAGE_REGISTRY=my-registry.example.com/nico IMAGE_TAG=v1.0.0
```
This takes a long time: two architectures, mkosi images and Rust builds.

**Step 3: Save the verification loop.**

Copy the loop from the 'Verifying the build' section of the build manual into `verify-images.sh`. It reads `IMAGE_REGISTRY`, `IMAGE_TAG`, `NICO_ARCHES`, `BOOT_ARTIFACTS_ARCHES`, `DPU_ARCHES` and `ARM_ONLY` from the environment, with the Makefile defaults.

**Step 4: Run it with the same values you gave make.**

```sh
IMAGE_REGISTRY=my-registry.example.com/nico IMAGE_TAG=v1.0.0 bash verify-images.sh
```
Expected output is 14 lines like `PASS nico: linux/amd64,linux/arm64`.

**Step 5: Act on a FAIL.**

If you see, for example, `FAIL boot-artifacts-aarch64: got linux/amd64, want linux/amd64,linux/arm64`, the table in the docs maps it back to `images-bfb`. Rebuild that target with the same variables and re-run the loop.

### Your turn: finish it

You built with `make images-all NICO_ARCHES=amd64 DPU_ARCHES=arm64` to the default registry and tag. Fill in the verification environment and the expected PASS line for `nico`.

```text
export IMAGE_REGISTRY=localhost:5000 IMAGE_TAG=latest
export NICO_ARCHES=___ DPU_ARCHES=___
bash verify-images.sh
# expected first line: PASS nico: ___
```

<details>
<summary>Answer</summary>

`NICO_ARCHES=amd64` and `DPU_ARCHES=arm64`, matching the make command. The expected line is `PASS nico: linux/amd64`. `boot-artifacts-x86_64` still expects `linux/amd64,linux/arm64`, because `BOOT_ARTIFACTS_ARCHES` keeps its default.

</details>

### Your turn: on your own

On an x86_64 build host, an engineer runs `make images-machine-validation NICO_ARCHES=arm64` and it fails immediately. Explain why, and give two correct alternatives depending on whether they need amd64 or only ARM64.

<details>
<summary>Hint 1</summary>

Look at what the `machine-validation-runner` intermediate image is built for.

</details>

<details>
<summary>Hint 2</summary>

The compatibility target has a requirement on what `NICO_ARCHES` must contain.

</details>

<details>
<summary>Hint 3</summary>

There's a separate native target with an `-arm` suffix, but it needs an ARM64 host.

</details>

<details>
<summary>Answer</summary>

`images-machine-validation` requires `NICO_ARCHES` to include `amd64`. Its `machine-validation-runner` intermediate is built for amd64 and depends on the amd64 Core runtime base, so `NICO_ARCHES=arm64` alone fails fast. Alternatives: include amd64 (for example `NICO_ARCHES=amd64` or `"amd64 arm64"`) on this host, or, for an ARM64-only image, run `make images-machine-validation-arm` on an ARM64 Docker host.

</details>

### Explain it

In your own words: Why do you think NICo gives the control-plane images, the x86 boot artifact and the DPU BFB separate architecture variables instead of one global setting?

### Check

**1. After `make images-all-arm`, which variable must you set before running the verification loop?**

A. `NICO_ARCHES=amd64`
B. `ARM_ONLY=1`
C. `BOOT_ARTIFACTS_ARCHES=arm64`
D. Nothing, since the loop detects the target

<details>
<summary>Answer</summary>

**B.** `ARM_ONLY=1`

`ARM_ONLY=1` removes `boot-artifacts-x86_64` from the list and sets `NICO_ARCHES` and `DPU_ARCHES` to arm64, giving 13 checks. `images-all-arm` doesn't use `BOOT_ARTIFACTS_ARCHES`, and the loop can't detect which target you ran.

</details>

**2. Which image is NOT built by `make images-all`?**

A. `nico-mcp`
B. `boot-artifacts-aarch64`
C. `machine-validation`
D. The machine lifecycle test image

<details>
<summary>Answer</summary>

**D.** The machine lifecycle test image

The machine lifecycle image is a QA tool built with `make images-machine-lifecycle`, and `images-all` doesn't include it. The other three are among the 14 images `images-all` produces.

</details>

**3. Which variable controls the container platforms of `boot-artifacts-x86_64`?**

<details>
<summary>Answer</summary>

`BOOT_ARTIFACTS_ARCHES`

`BOOT_ARTIFACTS_ARCHES` covers the x86 boot-artifact image (`images-boot-artifacts`). `NICO_ARCHES` is for control-plane images and `DPU_ARCHES` is for the BFB image.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

<a id="boot-artifacts"></a>
## 9. Boot artifacts

*Builds on: PXE / iPXE boot (ch. 12)*

### Before you read

- A server PXE-boots from the network with an empty disk. From Chapter 12, what does the network have to give it before it can run anything useful?
- Can a container image built for `linux/amd64` carry files meant for an arm64 machine?

<details>
<summary>Answers</summary>

- **A server PXE-boots from the network with an empty disk. From Chapter 12, what does the network have to give it before it can run anything useful?** A boot program (such as iPXE) and an OS to boot: typically a kernel and initial ramdisk or a full OS image, plus the scripts or config that tie them together.
- **Can a container image built for `linux/amd64` carry files meant for an arm64 machine?** Yes. A container can be just a carrier of files. Its platform says which CPU can *run the container*, not what the files inside are for.

</details>

### Explanation

**Boot artifacts** are the OS images and binaries NICo serves to hosts and DPUs that network-boot. The glossary says NICo runs its own PXE server to serve images shipped as part of the software, such as DPU software and iPXE. They're built from two upstream projects pulled in as Git submodules by the bootstrap:

- **iPXE**, the open-source network bootloader from Chapter 12, built from source.
- **mkosi**, a systemd-project tool that builds bootable OS images from distribution packages. The bootstrap's apt list also installs `systemd-boot` and `systemd-ukify`, tools for EFI boot loaders and unified kernel images.

The build has two stages. First, a cargo-make task in `pxe/` produces the artifacts. Then a Dockerfile packages them into an image:

```sh
cargo make --cwd pxe --env SA_ENABLEMENT=1 build-boot-artifacts-x86-host-sa
docker build --build-arg "CONTAINER_RUNTIME_X86_64=alpine:latest" \
  -t boot-artifacts-x86_64 -f dev/docker/Dockerfile.release-artifacts-x86_64 .
```

In the `make` workflow this is the `images-boot-artifacts` target. It's part of `images-all` and produces `boot-artifacts-x86_64`. Its sibling `boot-artifacts-aarch64` (next lesson) holds the DPU payload. Both need the full mkosi + Rust toolchain, which is one reason the bootstrap exists.

**Why put files in a container?** It's how everything else in NICo ships. Images get versioned tags, live in the same registry and are pulled by Kubernetes like any other image. The runtime base here is just `alpine:latest`: a small shell around the files.

**The key idea: container platform ≠ payload architecture.** The name `boot-artifacts-x86_64` describes the *payload*, an OS for x86 hosts. Its container platforms are a separate setting, `BOOT_ARTIFACTS_ARCHES`, which defaults to `amd64 arm64`, so the image can be pulled on either kind of control-plane node. `images-all-arm` skips this image entirely.

**Analogy.** A boot-artifact image is a shipping container full of flat-pack furniture. The container's spec (its platform) has to fit the truck and crane (the node that pulls and runs it), while the furniture inside is built for a completely different room (the machine that boots it). The analogy breaks down because a real shipping container doesn't care about the truck's make, whereas a container image's platform does have to match the node that runs it.

### Worked example: Pack an arm64 payload into an amd64 carrier image (no emulation needed)

**Step 1: Extract a foreign binary without running it.**

```sh
mkdir -p carrier/artifacts && cd carrier
docker create --platform linux/arm64 --name bb-arm busybox:latest
docker cp bb-arm:/bin/busybox artifacts/busybox-aarch64
docker rm bb-arm
file artifacts/busybox-aarch64     # ELF 64-bit ... ARM aarch64, statically linked
```
`docker create` doesn't execute anything, so this works even without QEMU.

**Step 2: Write a carrier Dockerfile.**

```sh
cat > Dockerfile <<'EOF'
FROM alpine:latest
COPY artifacts/ /artifacts/
EOF
```

**Step 3: Build it for amd64.**

```sh
docker build --platform linux/amd64 -t lab-artifacts-aarch64 .
docker image inspect lab-artifacts-aarch64 --format '{{.Os}}/{{.Architecture}}'   # linux/amd64
```
Only `COPY` runs, so this also builds on an arm Mac without emulation.

**Step 4: Get the payload back out.**

```sh
docker create --name art lab-artifacts-aarch64
docker cp art:/artifacts ./out
docker rm art
file out/busybox-aarch64          # still ARM aarch64
```
You now have an amd64 container carrying an aarch64 payload, the same shape as NICo's DPU artifact image.

### Your turn: finish it

Make the carrier's base image configurable with a build argument, like NICo's `CONTAINER_RUNTIME_X86_64`, defaulting to alpine. Then build it, passing alpine explicitly.

```text
# Dockerfile
ARG CONTAINER_RUNTIME=___
FROM ___
COPY artifacts/ /artifacts/

# shell
docker build --build-arg "CONTAINER_RUNTIME=alpine:latest" -t lab-artifacts-aarch64 .
```

<details>
<summary>Answer</summary>

The first blank is `alpine:latest` (an `ARG` declared before `FROM` can set the base image). The second is `${CONTAINER_RUNTIME}`.

</details>

### Your turn: on your own

Someone says: '`boot-artifacts-x86_64` is x86, so building it with `BOOT_ARTIFACTS_ARCHES=arm64` is nonsense and should fail.' Explain why that's wrong. Then say what `BOOT_ARTIFACTS_ARCHES=arm64` would actually produce, and which deployment that might suit.

<details>
<summary>Hint 1</summary>

Separate 'what the files inside are for' from 'what CPU pulls and runs the container'.

</details>

<details>
<summary>Hint 2</summary>

The image's runtime base is a tiny Alpine image whose job is to carry the files.

</details>

<details>
<summary>Hint 3</summary>

Think of control-plane nodes that are ARM64 serving x86 hosts.

</details>

<details>
<summary>Answer</summary>

The `x86_64` in the name describes the payload: the OS and boot files served to x86 hosts. `BOOT_ARTIFACTS_ARCHES` controls the container's platform, meaning which control-plane nodes can pull and run the carrier. `arm64` is one of the two accepted values, so the build is valid. It produces a `boot-artifacts-x86_64` tag whose index has a single `linux/arm64` entry, which carries x86 boot files. That suits a site whose Kubernetes nodes are ARM64 but whose managed hosts are x86. (The default builds both platforms.)

</details>

### Explain it

In your own words: Why does packaging boot files into container images make sense for a system that's otherwise deployed with Kubernetes and Helm?

### Check

**1. Which two upstream projects are brought in as submodules to build boot artifacts?**

A. mkosi and iPXE
B. Kea and iPXE
C. systemd and GRUB
D. QEMU and BuildKit

<details>
<summary>Answer</summary>

**A.** mkosi and iPXE

The bootstrap pulls 'the mkosi/ipxe git submodules'. Kea is the DHCP server in the DHCP service image, and QEMU/BuildKit are build tools, not boot payloads.

</details>

**2. In the manual x86 boot-artifact build, what's the base for the packaged image?**

A. `nico-runtime-container-x86_64`
B. `alpine:latest`, passed as `CONTAINER_RUNTIME_X86_64`
C. `ubuntu:24.04`
D. `scratch`

<details>
<summary>Answer</summary>

**B.** `alpine:latest`, passed as `CONTAINER_RUNTIME_X86_64`

The docs build it with `--build-arg "CONTAINER_RUNTIME_X86_64=alpine:latest"`. The heavier `nico-runtime-container-x86_64` is used for Core and machine-validation images, not for the artifact carrier.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="dpu-bfb"></a>
## 10. DPU BFB

*Builds on: BlueField DPU (ch. 7), Boot artifacts (ch. 13)*

### Before you read

- A BlueField DPU has its own Arm cores (Chapter 7). What CPU architecture must the OS installed *on the DPU* be built for?
- How might you get a fresh OS onto a DPU when the DPU has nothing usable installed?

<details>
<summary>Answers</summary>

- **A BlueField DPU has its own Arm cores (Chapter 7). What CPU architecture must the OS installed *on the DPU* be built for?** aarch64 (arm64), whatever the architecture of the host server or the control-plane nodes.
- **How might you get a fresh OS onto a DPU when the DPU has nothing usable installed?** Push an install image to it through a path that doesn't need the DPU OS, such as rshim from the host (Chapter 7) or the DPU's BMC. The image format used for this is the BFB.

</details>

### Explanation

A **BFB (BlueField bootstream)** is the image format used to install or update the operating system and firmware bundle on a BlueField DPU (glossary). Think of it as a self-contained installer stream: boot components, a kernel and installer environment, and the root filesystem to write to the DPU's storage. It's typically delivered over **rshim**, the host-side interface from Chapter 7, which exposes a boot device you stream the BFB into. It can also be delivered through the DPU's BMC. Install-time settings can be supplied through a `bf.cfg` file, which a later chapter covers. NICo is responsible for installing the DPU OS and all DPU firmware, so it needs its own BFB.

NICo builds the BFB as its **aarch64 boot artifact**:

```sh
cargo make --cwd pxe --env SA_ENABLEMENT=1 build-boot-artifacts-bfb-sa
docker build --build-arg "CONTAINER_RUNTIME_AARCH64=alpine:latest" \
  -t boot-artifacts-aarch64 -f dev/docker/Dockerfile.release-artifacts-aarch64 .
```

The docs stress that `CONTAINER_RUNTIME_AARCH64=alpine:latest` must be included, and that 'the aarch64 binaries are bundled into an x86 container'. This is the payload-vs-platform split from the previous lesson. The payload is aarch64 because it's for the DPU. In this manual command, the carrier is an x86 container.

In the `make` workflow:

- `images-bfb` builds `boot-artifacts-aarch64` with container platforms from **`DPU_ARCHES`** (default `amd64 arm64`).
- `images-bfb-arm` builds it natively on an ARM64 host. `images-all-arm` sets `DPU_ARCHES=arm64` and uses this path. The native DPU artifact build also leaves out the deployment-local `carbide-pxe.forge` package source, so it doesn't depend on that service being reachable during the build.
- The verification loop expects `boot-artifacts-aarch64` to match `DPU_ARCHES`.

The Quick Start also describes DPF as the default per-host DPU provisioning path, with iPXE as a deprecated opt-out. Later chapters cover how each path uses DPU images. This chapter covers only how the BFB artifact is built and published.

**Analogy.** A BFB is like a factory reimaging kit for a phone: one sealed file you push over a service cable, and the phone wipes itself and comes back with a fresh OS and firmware. The analogy holds for rshim as the 'service cable'. It breaks down because NICo ships that kit inside a container image so it can be versioned and distributed like the rest of the stack.

### Worked example: Trace the DPU BFB from build to verification

**Step 1: Build the artifact (Ubuntu build host).**

```sh
cargo make --cwd pxe --env SA_ENABLEMENT=1 build-boot-artifacts-bfb-sa
```
This runs the BFB task from `pxe/Makefile.toml` with `SA_ENABLEMENT=1`. It needs the mkosi submodule and the Rust toolchain from the bootstrap.

**Step 2: Package it into a carrier image.**

```sh
docker build --build-arg "CONTAINER_RUNTIME_AARCH64=alpine:latest" \
  -t boot-artifacts-aarch64 -f dev/docker/Dockerfile.release-artifacts-aarch64 .
```

**Step 3: Or let make do both and publish.**

```sh
make images-bfb DPU_ARCHES=arm64            # carrier for arm64 nodes only
# on an ARM64 host, natively:
make images-bfb-arm
```

**Step 4: Check the published platforms match DPU_ARCHES.**

```sh
docker buildx imagetools inspect --raw localhost:5000/boot-artifacts-aarch64:latest | \
  jq -r '[.manifests[].platform | select(.os == "linux") | "\(.os)/\(.architecture)"] | unique | sort | join(",")'
# want: linux/arm64 (for DPU_ARCHES=arm64)
```

### Your turn: finish it

Complete the manual packaging step for the DPU BFB exactly as the build manual gives it.

```text
docker build --build-arg "CONTAINER_RUNTIME_AARCH64=___" -t ___ -f dev/docker/Dockerfile.release-artifacts-aarch64 .
```

<details>
<summary>Answer</summary>

The first blank is `alpine:latest`, which the docs say must be included. The second is `boot-artifacts-aarch64`.

</details>

### Your turn: on your own

You need only the DPU BFB image, rebuilt after a fix, pushed to `my-registry.example.com/nico` with tag `v1.0.1`, as a container pullable by both amd64 and arm64 nodes, from an x86_64 build host. Write the make command and the verification expectation for this one image.

<details>
<summary>Hint 1</summary>

The individual target for the BFB image appears in the `make help` list in the docs.

</details>

<details>
<summary>Hint 2</summary>

Which architecture variable belongs to that target, and what's its default?

</details>

<details>
<summary>Hint 3</summary>

Use `IMAGE_REGISTRY` and `IMAGE_TAG`. With the default `DPU_ARCHES`, the expected platform string has two entries.

</details>

<details>
<summary>Answer</summary>

Log in first, then run `make images-bfb IMAGE_REGISTRY=my-registry.example.com/nico IMAGE_TAG=v1.0.1` (`DPU_ARCHES` defaults to `amd64 arm64`, so you don't need to set it). The arm64 carrier comes from the builder's emulated platform on this x86 host. Verify that `my-registry.example.com/nico/boot-artifacts-aarch64:v1.0.1` reports `linux/amd64,linux/arm64`. The payload inside is aarch64 either way.

</details>

### Explain it

In your own words: Why must the BFB payload always be aarch64, while the container that carries it can be amd64, arm64 or both?

### Check

**1. What is a BFB?**

A. A container image format for DPU microservices
B. The BlueField bootstream image format used to install or update the OS and firmware bundle on a BlueField DPU
C. A Redfish endpoint on the DPU BMC
D. A Kubernetes CRD for DPU provisioning

<details>
<summary>Answer</summary>

**B.** The BlueField bootstream image format used to install or update the OS and firmware bundle on a BlueField DPU

The glossary defines it this way. NICo ships it *inside* a container image (`boot-artifacts-aarch64`), but the BFB itself isn't a container format.

</details>

**2. Which variable sets the published platforms of `boot-artifacts-aarch64`?**

A. `NICO_ARCHES`
B. `BOOT_ARTIFACTS_ARCHES`
C. `DPU_ARCHES`
D. `CONTAINER_RUNTIME_AARCH64`

<details>
<summary>Answer</summary>

**C.** `DPU_ARCHES`

`DPU_ARCHES` controls the DPU BFB image (`images-bfb`), and the verification loop maps `boot-artifacts-aarch64` to it. `BOOT_ARTIFACTS_ARCHES` is for the x86 artifact. `CONTAINER_RUNTIME_AARCH64` sets the carrier's base image, not its platforms.

</details>

**3. What does the native ARM64 DPU artifact build (as used by `images-all-arm`) leave out, and why?**

<details>
<summary>Answer</summary>

It leaves out the deployment-local `carbide-pxe.forge` package source, so the native build doesn't depend on that service being reachable.

This comes straight from the build manual's description of `images-all-arm`.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="build-task"></a>
## Build task: Ship a multi-arch Rust image through a local registry, NICo-style

**Goal:** Build a tiny Rust program into container images for linux/amd64 and linux/arm64 in separate builds, pinned to one Docker context and builder. Push them to a local registry on localhost:5000, assemble one multi-arch tag, and check it with the same jq platform check NICo's verification loop uses.

**Why it matters for NICo:** This is `make images` in miniature. A Rust binary is compiled inside a container, each architecture is built separately (as NICo does to avoid copying an amd64 binary into the arm64 image), the non-native one is emulated through binfmt/QEMU, the results are pushed to `localhost:5000`, and the bare tag is assembled and verified. Once this works on your laptop, a `FAIL` line from the real verification loop is something you can reason about rather than guess at.

**You need:**

- Docker Engine with Buildx (`docker buildx version`), or Docker Desktop on macOS
- Linux only: QEMU registered via binfmt_misc, done in step 1. Docker Desktop already includes emulation.
- `jq` and `curl`
- About 2 GB free disk and some patience: the arm64 (or amd64 on Apple silicon) Rust build runs under emulation and can take several minutes
- No local Rust install needed, because the compiler runs in the `rust:1-slim-bookworm` image

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Enable and confirm emulation</summary>

On Linux:
```sh
ls /proc/sys/fs/binfmt_misc/ | grep qemu || \
  sudo docker run --privileged --rm tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 --install all
docker run --rm --platform linux/arm64 alpine uname -m   # aarch64
docker run --rm --platform linux/amd64 alpine uname -m   # x86_64
```
Remember that these registrations disappear on reboot. On Docker Desktop, just run the two `uname` checks.

</details>

<details>
<summary>Step 2: Pin the context and builder, and start a registry</summary>

```sh
ctx="$(docker context show)"
export DOCKER_CONTEXT="$ctx" BUILDX_BUILDER="$ctx"
docker buildx ls | grep -E "^$ctx"       # the built-in builder (docker driver)
docker run -d --name lab-registry -p 5000:5000 registry:2
curl -s http://localhost:5000/v2/         # {}
```
If `lab-registry` already exists from an earlier lesson, skip the `docker run` (or `docker start lab-registry`).

</details>

<details>
<summary>Step 3: Write the Rust crate</summary>

```sh
mkdir -p archecho/src && cd archecho
cat > Cargo.toml <<'EOF'
[package]
name = "archecho"
version = "0.1.0"
edition = "2021"
EOF
cat > src/main.rs <<'EOF'
fn main() {
    println!("archecho built for {}-{}", std::env::consts::ARCH, std::env::consts::OS);
}
EOF
```
`std::env::consts::ARCH` is fixed at compile time, so the output shows which architecture the binary was *built* for.

</details>

<details>
<summary>Step 4: Write a two-stage Dockerfile</summary>

```sh
cat > Dockerfile <<'EOF'
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml .
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=build /src/target/release/archecho /usr/local/bin/archecho
ENTRYPOINT ["/usr/local/bin/archecho"]
EOF
```
Both stages use the same Debian release (bookworm). The binary links dynamically against the glibc of the stage that built it. If the build stage had a newer glibc than the runtime stage (for example plain `rust:1-slim`, which now follows a newer Debian release), the program could fail at start-up with `GLIBC_x.yy not found` once it uses more of the C library. Matching the releases rules this out.

</details>

<details>
<summary>Step 5: Build each architecture separately and push per-arch tags</summary>

```sh
for arch in amd64 arm64; do
  docker buildx build --platform "linux/$arch" --provenance=false \
    -t "localhost:5000/archecho:latest-$arch" --push .
done
curl -s http://localhost:5000/v2/archecho/tags/list
```
`--provenance=false` stops BuildKit from adding attestation entries, so the per-arch tags stay simple. One build will be slow because it's emulated.

</details>

<details>
<summary>Step 6: Assemble the bare multi-arch tag</summary>

```sh
docker buildx imagetools create -t localhost:5000/archecho:latest \
  localhost:5000/archecho:latest-amd64 localhost:5000/archecho:latest-arm64
docker buildx imagetools inspect localhost:5000/archecho:latest
```

</details>

<details>
<summary>Step 7: Verify like NICo does</summary>

```sh
cat > verify.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
IMAGE_REGISTRY="${IMAGE_REGISTRY:-localhost:5000}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
ARCHES="${ARCHES:-amd64 arm64}"
expected="$(echo "$ARCHES" | tr ' ' '\n' | sed 's#^#linux/#' | sort | paste -sd, -)"
for image in archecho; do
  platforms="$(docker buildx imagetools inspect --raw "${IMAGE_REGISTRY}/${image}:${IMAGE_TAG}" | \
    jq -r '[.manifests[].platform | select(.os == "linux") | "\(.os)/\(.architecture)"] | unique | sort | join(",")')"
  if [ "$platforms" != "$expected" ]; then
    printf 'FAIL %s: got %s, want %s\n' "$image" "$platforms" "$expected" >&2; exit 1
  fi
  printf 'PASS %s: %s\n' "$image" "$platforms"
done
EOF
bash verify.sh
for arch in amd64 arm64; do
  docker run --rm --pull always --platform "linux/$arch" localhost:5000/archecho:latest
done
```

</details>

**Check it works:** `bash verify.sh` prints `PASS archecho: linux/amd64,linux/arm64`. Running the bare tag prints `archecho built for x86_64-linux` with `--platform linux/amd64` and `archecho built for aarch64-linux` with `--platform linux/arm64`.

<details>
<summary>If you get stuck</summary>

- `exec format error` during the emulated build or run means binfmt isn't registered (for example after a reboot). Re-run the `tonistiigi/binfmt --install all` command and check `/proc/sys/fs/binfmt_misc/`.
- `ERROR: ... no builder "..." found` means `BUILDX_BUILDER` doesn't match a builder name. Run `docker buildx ls`: the built-in builder is named after the context (`default`, or `desktop-linux` on Docker Desktop).
- If `--push` fails with a connection error, check that the registry is up: `docker ps --filter name=lab-registry` and `curl -s http://localhost:5000/v2/`.
- If `imagetools create` can't talk to the plain-HTTP registry on your setup, you can assemble the list with the Docker CLI instead: `docker manifest create --insecure localhost:5000/archecho:latest localhost:5000/archecho:latest-amd64 localhost:5000/archecho:latest-arm64`, then `docker manifest push --insecure localhost:5000/archecho:latest`.
- If the container fails with `GLIBC_x.yy not found`, the build and runtime stages are on different Debian releases. Keep `rust:1-slim-bookworm` with `debian:bookworm-slim` (or move both to the same newer release).
- If both `docker run` lines print the same architecture, a cached local image was reused. Keep `--pull always`, or remove the local tag with `docker image rm localhost:5000/archecho:latest`.
- `FAIL archecho: got linux/amd64, want linux/amd64,linux/arm64` means the arm64 per-arch tag is missing or wasn't included in `imagetools create`. Check `tags/list` and rebuild that architecture.

</details>

**Stretch goal:** Add a second image, `archecho-artifacts-aarch64`, that mimics NICo's DPU artifact. Extract the arm64 `archecho` binary from `localhost:5000/archecho:latest-arm64` with `docker create --platform linux/arm64` + `docker cp`. Package it into an `alpine:latest` carrier whose base comes from a `CONTAINER_RUNTIME` build arg, and push it for `linux/amd64` only. Extend `verify.sh` with a per-image `expected_platforms_for` function (as in NICo's loop) so `archecho` expects both platforms and `archecho-artifacts-aarch64` expects `linux/amd64`. Then confirm with `file` that the payload you copy out of the amd64 carrier is still `ARM aarch64`.

## Review notes

The draft was rewritten once using review issues; the notes below are from the last review.

This chapter was written with 7 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **ok**, no issues found.

---

[← 12-boot-network-services.md](12-boot-network-services.md) · [14-kubernetes-basics.md →](14-kubernetes-basics.md)
