# Chapter 13: Building Images

*Part: Kubernetes & Deployment · 10 concepts · [curriculum](../curriculum.md#chapter-13)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Until now you've studied what NICo *does*: state machines, BMCs and Redfish, DPUs, DHCP/PXE, BGP and the VXLAN/EVPN overlay. Before you can deploy any of it to Kubernetes (the next part of the course), you need the software in a form a cluster can run: **container images in a registry**, plus the **boot artifacts** that NICo's PXE service hands to network-booting hosts and DPUs.

This chapter follows the build pipeline from the bottom up. NICo is written in Rust, so it starts with the Rust toolchain and Cargo, including `cargo-make`, the task runner NICo uses. Next comes `make bootstrap`, the single step that prepares an Ubuntu 24.04 build host. Then the container plumbing: registries, BuildKit and Buildx, and the quick single-service `make images-dev` loop. The middle lessons deal with CPU architecture. NICo runs on amd64 control-plane nodes and on arm64 hardware, including the BlueField DPU's Arm cores. You'll learn how QEMU emulation works, how a multi-architecture manifest lets one tag serve both architectures, and how `make images` builds and checks the whole deployable stack.

The last two lessons cover what NICo serves to machines that have no OS yet. Boot artifacts are built with mkosi and iPXE and shipped inside containers. The DPU's BFB (BlueField bootstream) is the aarch64 boot artifact. It reaches the cluster inside a container whose image platform can differ from the CPU architecture of the files it carries.

The chapter ends with a build you can do on a laptop. You'll compile a tiny Rust program for two architectures and push it to a local registry. Then you'll combine the images under one multi-arch tag, package an aarch64 "boot artifact" the way NICo does, and check everything with a loop modelled on NICo's own.

**By the end of this chapter you can:**

- Explain how rustup, rustc, cargo and cargo-make fit together, and run Cargo and cargo-make tasks
- Prepare and verify an Ubuntu 24.04 NICo build host with `make bootstrap`, and explain why a reboot is needed afterwards
- Build a single NICo dev service image with `make images-dev` and smoke-test it, choosing the right Make variables
- Explain how BuildKit builders, Docker contexts and binfmt/QEMU emulation decide where, and for which CPU, an image is built
- Build per-architecture images, combine them into a multi-arch tag in a registry, and verify each tag's platforms with `docker buildx imagetools inspect`
- Choose the correct `make images*` target and architecture variables for a deployment, and explain what boot-artifact and DPU BFB images contain

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
11. [Build task: Ship a multi-arch Rust service and an aarch64 artifact through a local registry, NICo-style](#build-task)

<a id="rust-toolchain-and-cargo"></a>
## 1. Rust toolchain and Cargo

### Before you read

- Rust has three command-line tools you'll keep meeting: `rustup`, `rustc` and `cargo`. Guess what each one does.
- NICo's docs run `cargo make build-cli`. Is that the same `make` you know from Makefiles?

<details>
<summary>Answers</summary>

- **Rust has three command-line tools you'll keep meeting: `rustup`, `rustc` and `cargo`. Guess what each one does.** `rustc` is the compiler. `rustup` installs and switches Rust toolchains (versions and target platforms). `cargo` is the build tool and package manager, and it calls `rustc` for you.
- **NICo's docs run `cargo make build-cli`. Is that the same `make` you know from Makefiles?** No. `cargo make` runs cargo-make, a separate tool installed with `cargo install cargo-make`. It runs tasks defined in TOML, not in a GNU Makefile. NICo uses both: GNU Make targets such as `make images` and cargo-make tasks such as `cargo make build-cli`.

</details>

### Explanation

NICo Core is written in **Rust**. Building it involves four tools:

- **`rustc`**, the Rust compiler. It turns `.rs` source files into a native binary for one CPU architecture.
- **`rustup`**, the toolchain manager. It installs `rustc` and `cargo`, keeps them updated, and can add compilation targets (for example `aarch64-unknown-linux-gnu`). NICo's bootstrap installs it with the standard `curl ... https://sh.rustup.rs | sh` script.
- **`cargo`**, Rust's build tool and package manager. A Rust project (a *crate*) is described by `Cargo.toml`, a TOML file listing its name, version and dependencies. Cargo downloads dependencies, calls `rustc` in the right order and writes output under `target/` (`target/debug/` by default, `target/release/` with `--release`). A *workspace* groups many crates in one repository, and `-p <name>` picks one of them. NICo's quick start builds the gRPC admin CLI this way: `cargo build --release -p nico-admin-cli`, which produces `target/release/nico-admin-cli`.
- **`cargo-make`**, a task runner. `cargo install <tool>` compiles a tool and places it in `~/.cargo/bin`. Cargo treats any `cargo-<name>` binary on your `PATH` as a subcommand, so installing `cargo-make` makes `cargo make` work. cargo-make reads tasks from a TOML task file (by default `Makefile.toml` in the working directory) and runs them.

NICo drives several builds through cargo-make. These two commands come from its build manual:

```sh
BUILD_CONTAINER_X86_URL="nico-buildcontainer-x86_64" cargo make build-cli
cargo make --cwd pxe --env SA_ENABLEMENT=1 build-boot-artifacts-bfb-sa
```

`--cwd pxe` runs the task from the `pxe` directory, and `--env NAME=value` sets an environment variable for the task. NICo's build host also gets `cargo-cache` (inspects and cleans Cargo's download cache) and, through apt, `sccache` (a compiler-output cache).

The overall picture: a top-level **GNU Make** layer (`make bootstrap`, `make images`) handles the big workflows, and **cargo-make** tasks handle Rust-aware steps such as building the CLI and the boot artifacts.

**Analogy.** rustup is the shop that sells and services your power tools, and rustc is the saw. cargo is the workbench that holds the plans and parts list and runs the saw for you. cargo-make is the job sheet that says "for this job, run these steps in this order." The analogy breaks down because real workbenches don't fetch parts: cargo downloads dependencies automatically and locks their exact versions in `Cargo.lock`.

### Worked example: Build a tiny crate and drive it with cargo-make

**Step 1: Install the toolchain.**

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # choose option 1
. "$HOME/.cargo/env"
rustc --version && cargo --version
```

**Step 2: Create a crate.**

```sh
cargo new hello-arch && cd hello-arch
cat Cargo.toml   # [package] name, version, edition; empty [dependencies]
```
Replace `src/main.rs` with:
```rust
fn main() {
    println!("hello-arch {} {}", std::env::consts::ARCH, std::env::consts::OS);
}
```

**Step 3: Build and run.**

```sh
cargo run                 # debug build, prints e.g. hello-arch x86_64 linux
cargo build --release
ls target/release/hello-arch
file target/release/hello-arch   # ELF for your CPU only
```
The binary contains machine code for one architecture. Keep that in mind for the emulation lessons.

**Step 4: Install cargo-make as a cargo subcommand.**

```sh
cargo install cargo-make
ls ~/.cargo/bin/cargo-make
cargo make --version
```

**Step 5: Define and run a task.**

Create `Makefile.toml`:
```toml
[tasks.greet]
command = "echo"
args = ["greeting from", "${GREETING_SOURCE}"]
```
Run it with an environment variable, just as NICo passes `SA_ENABLEMENT=1`:
```sh
cargo make --env GREETING_SOURCE=cargo-make greet
```

### Your turn: finish it

Add a cargo-make task named `release` to `Makefile.toml` that runs an optimised build, so that `cargo make release` produces `target/release/hello-arch`. Fill in the blanks.

```text
[tasks.release]
command = "___"
args = ["build", "___"]
```

<details>
<summary>Answer</summary>

[tasks.release]
command = "cargo"
args = ["build", "--release"]

</details>

### Your turn: on your own

You're at the root of the NICo repo. Write the command that runs the cargo-make task `build-boot-artifacts-x86-host-sa` from the `pxe` directory with `SA_ENABLEMENT=1` set. Then say which program has to be installed for it to work, and how it got there on a NICo build host.

<details>
<summary>Hint 1</summary>

The command starts with `cargo make`. Look at the two flags in this lesson's BFB example.

</details>

<details>
<summary>Hint 2</summary>

One flag changes the working directory and the other sets an environment variable.

</details>

<details>
<summary>Hint 3</summary>

`cargo make --cwd pxe --env SA_ENABLEMENT=1 <task>`. The binary it needs lives in `~/.cargo/bin`.

</details>

<details>
<summary>Answer</summary>

`cargo make --cwd pxe --env SA_ENABLEMENT=1 build-boot-artifacts-x86-host-sa`. It needs the `cargo-make` binary, which `make bootstrap` installs with `cargo install cargo-make cargo-cache`. Cargo then finds `cargo-make` on the PATH and runs it as the `make` subcommand.

</details>

### Explain it

In your own words: Why might a large Rust project like NICo keep a GNU Make layer (`make images`) *and* cargo-make tasks, instead of putting everything into `cargo build`?

### Check

**1. After `cargo install cargo-make`, why does `cargo make` work?**

A. Cargo runs any `cargo-<name>` binary on your PATH as the subcommand `<name>`
B. cargo-make has been built into Cargo since Rust 1.70
C. `cargo install` adds an alias to `Cargo.toml`
D. GNU Make reads `Cargo.toml` when it's called through cargo

<details>
<summary>Answer</summary>

**A.** Cargo runs any `cargo-<name>` binary on your PATH as the subcommand `<name>`

`cargo install` puts `cargo-make` in `~/.cargo/bin`, and Cargo's subcommand lookup finds it there. It isn't built into Cargo, it doesn't edit `Cargo.toml`, and it has nothing to do with GNU Make.

</details>

**2. Where does `cargo build --release -p nico-admin-cli` put the binary?**

A. target/release/nico-admin-cli
B. target/debug/nico-admin-cli
C. ~/.cargo/bin/nico-admin-cli
D. crates/admin-cli/bin/nico-admin-cli

<details>
<summary>Answer</summary>

**A.** target/release/nico-admin-cli

`--release` builds go under `target/release/`. `target/debug/` is for builds without `--release`, and `~/.cargo/bin` is where `cargo install` puts binaries, not `cargo build`.

</details>

**3. Which tool would you use to add a new compilation target such as aarch64 to your Rust installation?**

A. rustup
B. cargo-make
C. rustc
D. cargo-cache

<details>
<summary>Answer</summary>

**A.** rustup

rustup manages toolchains and targets. rustc only compiles with what's installed, cargo-make runs tasks, and cargo-cache manages Cargo's download cache.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="build-host-bootstrap"></a>
## 2. Build host bootstrap (make bootstrap)

*Builds on: Rust toolchain and Cargo (ch. 13)*

### Before you read

- Why would a project ship one bootstrap script rather than a list of 13 install commands for you to type?
- A script adds your user to the `docker` group. Straight afterwards, `docker ps` still says `permission denied`. Why?

<details>
<summary>Answers</summary>

- **Why would a project ship one bootstrap script rather than a list of 13 install commands for you to type?** A script is repeatable and consistent, so every build host ends up the same. If it's idempotent, re-running it is safe and fixes anything that was missed.
- **A script adds your user to the `docker` group. Straight afterwards, `docker ps` still says `permission denied`. Why?** Group membership is read when you log in. Your current session still has the old groups until you log out and back in, or reboot.

</details>

### Explanation

The full NICo image and boot-artifact build needs a lot of software. NICo bundles it into one step:

```sh
git clone git@github.com:dsx-ai-factory/infra-controller.git
cd infra-controller
make bootstrap          # or: ./scripts/setup-build-host.sh
```

**Requirements:** an Ubuntu 24.04 host or VM, at least **150 GB free disk**, Git and Make. The bootstrap **does not run on macOS**. On a Mac you use the `make images-dev` workflow against a Linux Docker daemon instead.

The script is **idempotent**: running it a second time leaves an already-configured host unchanged, so re-running it is safe. It does the same work as these manual steps:

1. **apt packages**: compilers (`build-essential`), image tools (`mkosi`, `systemd-boot`, `systemd-ukify`, `cpio`, `fakeroot`), Docker (`docker.io`, `docker-buildx`), `sccache`, `protobuf-compiler`, development libraries (`libssl-dev`, `libgrpc-dev`, `kea-dev`, and others), plus `jq`, `zip`, `direnv`.
2. **A direnv hook** for your shell, then `direnv allow` in the repo, so per-directory environment variables load automatically.
3. **rustup** (previous lesson).
4. **Git submodules**: `git submodule update --init --recursive` pulls in the mkosi and iPXE sources used for boot artifacts.
5. **Docker plus cross-architecture emulation**: enables `docker.socket` and runs the `tonistiigi/binfmt` image with `--install all`. The cross-architecture emulation lesson explains this.
6. **Cargo tooling**: `cargo install cargo-make cargo-cache`.
7. **A sysctl**: `kernel.apparmor_restrict_unprivileged_userns=0`, written to `/etc/sysctl.d/99-userns.conf`. This relaxes Ubuntu 24.04's AppArmor restriction on unprivileged user namespaces.
8. **Docker group**: `usermod -aG docker $(id -un)`.

Afterwards you must **reboot (or log out and back in)** so the docker group membership and the userns sysctl change take effect. If you skip this, the next build fails with errors that look unrelated to the bootstrap.

**Analogy.** It's like a recipe kit that delivers every ingredient and pre-heats the oven, so the result doesn't depend on who in the kitchen does the setup. The analogy breaks down because some settings only take effect after a reboot, as if the oven only noticed the dial after being switched off and on again.

### Worked example: Bootstrap an Ubuntu 24.04 VM and verify each piece

**Step 1: Check the host meets the requirements.**

```sh
lsb_release -ds        # Ubuntu 24.04.x LTS
df -h ~                # at least 150G available
git --version && make --version | head -1
```

**Step 2: Run the bootstrap.**

Clone into your home directory so the later steps can find it:
```sh
cd ~
git clone git@github.com:dsx-ai-factory/infra-controller.git
cd infra-controller
make bootstrap
```

**Step 3: Reboot.**

```sh
sudo reboot
```
This applies the docker group membership and the userns sysctl.

**Step 4: Verify toolchain and tooling.**

After logging back in, return to the clone:
```sh
cd ~/infra-controller
rustup --version; cargo --version
cargo make --version
docker buildx version
git submodule status   # no line should start with '-' (uninitialised)
```

**Step 5: Verify the system-level changes.**

```sh
id -nG | tr ' ' '\n' | grep -x docker                 # prints: docker
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns   # prints: 0
ls /proc/sys/fs/binfmt_misc/ | grep qemu-aarch64     # emulator registered
docker run --rm hello-world                           # works without sudo
```

**Step 6: Confirm idempotency.**

From inside `~/infra-controller`, run `make bootstrap` again. It should finish without breaking anything, which also makes it a quick way to repair a host where something was missed.

### Your turn: finish it

Complete this post-bootstrap check script. After a reboot, both lines should print their OK message.

```text
#!/usr/bin/env bash
id -nG | tr ' ' '\n' | grep -qx ___ && echo "docker group OK"
[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = "___" ] && echo "userns sysctl OK"
```

<details>
<summary>Answer</summary>

#!/usr/bin/env bash
id -nG | tr ' ' '\n' | grep -qx docker && echo "docker group OK"
[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = "0" ] && echo "userns sysctl OK"

</details>

### Your turn: on your own

A teammate ran `make bootstrap` over SSH, didn't reboot, and now `docker run hello-world` fails with `permission denied while trying to connect to the Docker daemon socket`. Explain the cause, give a fix, and say how they can confirm it worked.

<details>
<summary>Hint 1</summary>

Which bootstrap step gives a non-root user access to the Docker socket?

</details>

<details>
<summary>Hint 2</summary>

When does Linux read a user's group list for a session?

</details>

<details>
<summary>Hint 3</summary>

`usermod -aG docker` only affects new logins. Logging out and in, or rebooting (which the docs say to do), fixes it. `id -nG` confirms it.

</details>

<details>
<summary>Answer</summary>

The bootstrap added the user to the `docker` group with `usermod -aG docker`, but group membership is only picked up at login, so the existing SSH session doesn't have it. Reboot as the docs instruct (that also applies the userns sysctl), or at least log out and back in. Then check that `id -nG` lists `docker` and that `docker run --rm hello-world` works without sudo. A user-level re-login alone won't guarantee the sysctl is in effect, so a reboot is the safer fix.

</details>

### Explain it

In your own words: Why is it valuable that `make bootstrap` is idempotent, both for setting up a new build host and for fixing a broken one?

### Check

**1. You develop on a MacBook. What is the supported way to build NICo images there?**

A. Use `make images-dev` with a Linux Docker daemon
B. Run `make bootstrap` natively on macOS
C. Use Homebrew to install mkosi and run `make images-all`
D. macOS can't build any NICo images

<details>
<summary>Answer</summary>

**A.** Use `make images-dev` with a Linux Docker daemon

The bootstrap doesn't run on macOS, and the full stack build needs Ubuntu 24.04. The local dev service workflow only needs Git, Make and a Docker client connected to a Linux amd64/arm64 daemon, which you can have on a Mac.

</details>

**2. Why does the bootstrap run `git submodule update --init --recursive`?**

A. To fetch the mkosi and iPXE sources used for boot artifacts
B. To download Rust crates
C. To install Docker Buildx
D. To clone the REST API, which lives in a separate repo

<details>
<summary>Answer</summary>

**A.** To fetch the mkosi and iPXE sources used for boot artifacts

The docs describe the submodules as mkosi/ipxe. Cargo downloads crates, apt installs Buildx, and REST lives in-tree under `rest-api/`, not in a separate repo.

</details>

**3. What is the minimum free disk space the docs require for the full build host?**

A. 150 GB
B. 15 GB
C. 50 GB
D. 1 TB

<details>
<summary>Answer</summary>

**A.** 150 GB

The complete stack and boot-artifact workflow needs at least 150 GB free. Compiler images, Cargo caches for two architectures and OS images add up quickly.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

<a id="container-registry"></a>
## 3. Container registry

*Builds on: Containers and container images (ch. 2)*

### Before you read

- In `docker push localhost:5000/hello:1`, which part tells Docker where to send the image?
- Where does `docker push hello:1` (no host prefix) try to go?

<details>
<summary>Answers</summary>

- **In `docker push localhost:5000/hello:1`, which part tells Docker where to send the image?** The first component, `localhost:5000`, is the registry host and port. `hello` is the repository and `1` is the tag.
- **Where does `docker push hello:1` (no host prefix) try to go?** To Docker Hub (`docker.io`), as `docker.io/library/hello:1`, and you probably don't have permission to push there.

</details>

### Explanation

A **container registry** is an HTTP server that stores container images and serves them on request. Every image reference has the shape:

```
[registry-host[:port]/]repository[:tag | @digest]
```

- **Repository**: a named collection of images, e.g. `nico/nico-rest-api`.
- **Tag**: a movable, human-friendly name such as `latest` or `v1.0.0`.
- **Digest**: `sha256:...`, a content hash that never changes for the same content.

Internally a registry stores **blobs** (compressed layers and config) and **manifests** (JSON documents that list which blobs make up an image). Clients use the registry HTTP API under `/v2/`, so you can explore one with `curl`, e.g. `/v2/_catalog` or `/v2/<repo>/tags/list`.

You can run your own registry with the open-source `registry:2` image. By default Docker only allows plain HTTP (no TLS) to registries on `localhost`/`127.0.0.0/8`, which is why local registries usually live at `localhost:5000`.

**How NICo uses registries.** The image build pushes to `localhost:5000` by default and tags images `latest`, e.g. `localhost:5000/nico:latest`. When that default is in use, the Makefile starts a local registry container called `nico-build-registry` for you. (So on a host that has run `make images`, port 5000 may already be taken by that container.) To publish somewhere your cluster can reach, override the registry and tag, and **log Docker in to that registry first**:

```sh
make images IMAGE_REGISTRY=my-registry.example.com/nico IMAGE_TAG=v1.0.0
```

This matters at deploy time. The quick start says to push all images to your registry before running `setup.sh`, and to point `NICO_IMAGE_REGISTRY` at it (e.g. `my-registry.example.com/nico`). Preflight checks that the value has no URL scheme (no `https://`) and that the registry host answers an HTTPS probe. A `localhost:5000` registry on your build host is fine for builds, but cluster nodes can't pull from it.

**Analogy.** A registry is like a bank of package lockers. The address on the label (registry host) picks the building. The locker name (repository) and the sticky note (tag) find the box, and the tamper seal (digest) proves the contents haven't changed. The analogy breaks down because sticky notes can be moved: a tag can be repointed to different content later, but a digest can't.

### Worked example: Run a local registry and push, list and pull an image

**Step 1: Start the registry.**

```sh
docker rm -f lab-registry 2>/dev/null || true
docker run -d -p 5000:5000 --name lab-registry registry:2
curl -s http://localhost:5000/v2/_catalog   # {"repositories":[]}
```
If port 5000 is already in use, use `-p 5001:5000` and `localhost:5001` in the commands below. Two common causes: AirPlay Receiver on macOS, and a running `nico-build-registry` on a host that has run `make images` (check with `docker ps --filter name=nico-build-registry`).

**Step 2: Re-tag an image for the registry.**

```sh
docker pull alpine:3.20
docker tag alpine:3.20 localhost:5000/tools/alpine:3.20
```
The new name's prefix tells Docker which registry to push to.

**Step 3: Push and inspect.**

```sh
docker push localhost:5000/tools/alpine:3.20
curl -s http://localhost:5000/v2/_catalog
curl -s http://localhost:5000/v2/tools/alpine/tags/list
```
Note the `digest: sha256:...` line printed by the push.

**Step 4: Pull by digest.**

```sh
docker image rm localhost:5000/tools/alpine:3.20
docker pull localhost:5000/tools/alpine@sha256:<digest-from-push>
```
Pulling by digest always gets exactly the same content.

**Step 5: Clean up.**

```sh
docker rm -f lab-registry
docker image rm localhost:5000/tools/alpine@sha256:<digest-from-push> 2>/dev/null || true
```
Removing the container frees port 5000 and the `lab-registry` name for later lessons and the build task. The registry's data lived inside the container, so it's gone too.

### Your turn: finish it

Tag `alpine:3.20` into your local registry under the repository `tools/alpine`, push it, then list the repository's tags with curl. Fill in the blanks.

```text
docker tag alpine:3.20 ___/tools/alpine:3.20
docker push localhost:5000/tools/alpine:3.20
curl -s http://localhost:5000/v2/tools/alpine/___
```

<details>
<summary>Answer</summary>

docker tag alpine:3.20 localhost:5000/tools/alpine:3.20
docker push localhost:5000/tools/alpine:3.20
curl -s http://localhost:5000/v2/tools/alpine/tags/list

</details>

### Your turn: on your own

Your cluster pulls from `registry.lab.internal/nico`. Write the commands to build the deployable stack into that registry with tag `v2.1.0`, including what you must do first. What would the full reference of the REST API image be?

<details>
<summary>Hint 1</summary>

Two Make variables control where images go and what they're tagged.

</details>

<details>
<summary>Hint 2</summary>

The docs say to authenticate Docker to the registry before building.

</details>

<details>
<summary>Hint 3</summary>

`docker login registry.lab.internal`, then `make images IMAGE_REGISTRY=... IMAGE_TAG=...`. The image name is `nico-rest-api`.

</details>

<details>
<summary>Answer</summary>

`docker login registry.lab.internal`, then `make images IMAGE_REGISTRY=registry.lab.internal/nico IMAGE_TAG=v2.1.0`. The REST API image would be `registry.lab.internal/nico/nico-rest-api:v2.1.0`. At deploy time you'd set `NICO_IMAGE_REGISTRY=registry.lab.internal/nico` with no `https://`.

</details>

### Explain it

In your own words: Why is a registry on `localhost:5000` fine for building images but not for deploying them to a Kubernetes cluster?

### Check

**1. You run `make images` without setting `IMAGE_REGISTRY`. Where do the images go?**

A. To `localhost:5000`, in a local registry the Makefile starts named `nico-build-registry`
B. To Docker Hub under the `nico` organisation
C. Only into the local Docker image store, never to a registry
D. To NGC (nvcr.io)

<details>
<summary>Answer</summary>

**A.** To `localhost:5000`, in a local registry the Makefile starts named `nico-build-registry`

That's the documented default. Keeping images only in the local store is what `make images-dev` does, not `make images`.

</details>

**2. Which `NICO_IMAGE_REGISTRY` value would preflight reject?**

A. https://my-registry.example.com/nico
B. my-registry.example.com/nico
C. registry.lab.internal/nico
D. nvcr.io/myorg/nico

<details>
<summary>Answer</summary>

**A.** https://my-registry.example.com/nico

Preflight checks that the registry has no URL scheme. Image references never include `https://`.

</details>

**3. What does an image digest give you that a tag doesn't?**

A. An immutable, content-addressed reference
B. Faster pulls
C. Automatic multi-architecture selection
D. Authentication to the registry

<details>
<summary>Answer</summary>

**A.** An immutable, content-addressed reference

A digest is a hash of the content, so it can't silently change, while a tag can be moved. Platform selection works through manifest lists, and tags and digests can both point to those.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="docker-buildkit-and-buildx"></a>
## 4. Docker BuildKit and Buildx

*Builds on: Containers and container images (ch. 2)*

### Before you read

- Docker can talk to several daemons (contexts) and use several builders. What could go wrong if one step of a build script checks the CPU architecture on one daemon and a later step builds on another?
- Build A creates a local image `mybase:latest`. Build B says `FROM mybase:latest`. Can that fail even though `docker images` lists `mybase`?

<details>
<summary>Answers</summary>

- **Docker can talk to several daemons (contexts) and use several builders. What could go wrong if one step of a build script checks the CPU architecture on one daemon and a later step builds on another?** The check would describe the wrong machine. You could build for the wrong architecture, or the build might not find images that an earlier step left in the other daemon's image store.
- **Build A creates a local image `mybase:latest`. Build B says `FROM mybase:latest`. Can that fail even though `docker images` lists `mybase`?** Yes. If build B runs on a builder that doesn't share the daemon's image store, such as a docker-container builder, it can't see `mybase` and tries to pull it from Docker Hub.

</details>

### Explanation

When you type `docker build`, three pieces are involved:

- **Docker context**: a named connection from your Docker client to a daemon (local socket, Docker Desktop's VM, a remote host over SSH). See them with `docker context ls`. The active one has a `*`. The `DOCKER_CONTEXT` environment variable overrides the active context.
- **BuildKit**: Docker's build engine. It runs independent Dockerfile stages in parallel, keeps a smart layer cache, supports cache mounts (`RUN --mount=type=cache,...`), and can target other platforms.
- **Buildx**: the CLI front end for BuildKit (`docker buildx build`, `docker buildx ls`, `docker buildx imagetools`). On current Docker, plain `docker build` is an alias for Buildx.

Buildx sends work to a **builder**. Each context has a **built-in builder** with the same name (e.g. `default` or `desktop-linux`) that uses the `docker` driver. That driver builds inside the daemon and writes results straight into the daemon's **image store**, so a later build can `FROM` an image the earlier one just made. You can also create extra builders (`docker buildx create --driver docker-container`). These run BuildKit in its own container with its own cache. That suits some multi-platform builds, but such builders can't see images in the daemon's image store. `--load` copies their result *into* the daemon, but it doesn't let them read from it, so a base image for a later build on that builder must come from a registry. The `BUILDX_BUILDER` environment variable picks the builder.

**Why NICo pins both.** `make images-dev` builds a compiler image, then a runtime image, then a service image that uses the first two. Its recipe captures the active Docker context **once** and sets it as both `DOCKER_CONTEXT` and `BUILDX_BUILDER`. The architecture check and every build therefore run on that context's built-in builder and image store, even if you've switched your default with `docker buildx use`. Custom Buildx builders aren't used, and intermediate images stay available to the next build without a registry. For the full `make images` targets, the docs note that building the non-native architecture uses the platforms configured on the **active Buildx builder**.

**Analogy.** The context is which kitchen you're in, BuildKit is the chef, and the builder is the chef's station that takes your order. The built-in station puts finished dishes on the kitchen's own shelf (the image store) and can take ingredients from it. A separate food truck (a docker-container builder) has its own fridge and can't see that shelf. The analogy breaks down at delivery: the truck can drop a finished dish onto the shelf (`--load`) or send it to a warehouse (a registry), but it still only fetches ingredients from the warehouse, never from the shelf.

### Worked example: See why chained builds need the built-in builder

**Step 1: Look at contexts and builders.**

```sh
docker context ls
docker context show            # e.g. default or desktop-linux
docker buildx ls               # built-in builder has the context's name, DRIVER 'docker'
```

**Step 2: Build a base image locally.**

```sh
mkdir -p chain/base chain/svc
printf 'FROM alpine:3.20\nRUN echo base > /base.txt\n' > chain/base/Dockerfile
printf 'FROM mybase:latest\nCMD ["cat", "/base.txt"]\n' > chain/svc/Dockerfile
docker build -t mybase:latest chain/base
```

**Step 3: Chain on the built-in builder: works.**

```sh
CTX=$(docker context show)
docker buildx build --builder "$CTX" -t mysvc:latest chain/svc
docker run --rm mysvc:latest   # prints: base
```

**Step 4: Chain on an isolated builder: fails.**

```sh
docker buildx create --name iso --driver docker-container
docker buildx build --builder iso -t mysvc:iso chain/svc
# ERROR ... docker.io/library/mybase:latest: pull access denied ...
```
The isolated BuildKit can't see the daemon's `mybase`, so it tries Docker Hub. Adding `--load` wouldn't help: that only controls where *this* build's output goes.

**Step 5: Clean up.**

```sh
docker buildx rm iso
docker image rm mysvc:latest mybase:latest
```

### Your turn: finish it

Write a snippet that pins a shell session to the current context's built-in builder, the way NICo's `images-dev` recipe does, so that later `docker build` calls can't drift to a different builder. Fill in the blank.

```text
CTX=$(docker context show)
export DOCKER_CONTEXT="$CTX"
export BUILDX_BUILDER="___"
docker buildx ls
```

<details>
<summary>Answer</summary>

CTX=$(docker context show)
export DOCKER_CONTEXT="$CTX"
export BUILDX_BUILDER="$CTX"
docker buildx ls

(The built-in builder has the same name as its context.)

</details>

### Your turn: on your own

Last week you ran `docker buildx use iso` to make a docker-container builder your default. Today, a hand-written script that builds a base image and then a service `FROM` that base fails while pulling the base from docker.io. Explain why, and explain why `make images-dev` wouldn't hit this problem.

<details>
<summary>Hint 1</summary>

Which builder does `docker build` use after `docker buildx use iso`?

</details>

<details>
<summary>Hint 2</summary>

Does a docker-container builder read images from the daemon's image store?

</details>

<details>
<summary>Hint 3</summary>

Consider what `images-dev` sets `BUILDX_BUILDER` to.

</details>

<details>
<summary>Answer</summary>

`docker buildx use iso` made the docker-container builder the default, so both builds ran in that isolated BuildKit. That builder can't read the daemon's image store, so when the service build resolved `FROM base` it looked for it in a registry and tried docker.io. Even loading the base into the daemon with `--load` wouldn't fix it, because `--load` only exports results into the daemon. The base would have to be pushed to a registry. `make images-dev` captures the active context and sets both `DOCKER_CONTEXT` and `BUILDX_BUILDER` to it, which forces the context's built-in `docker`-driver builder. Intermediate images land in the shared image store, so the next build finds them without a registry.

</details>

### Explain it

In your own words: Why does capturing the Docker context *once* at the start of a multi-step build make it more reliable than letting each step use whatever is currently active?

### Check

**1. What's the relationship between BuildKit and Buildx?**

A. BuildKit is the build engine and Buildx is the CLI front end that sends builds to it
B. Buildx is the engine and BuildKit is a GUI
C. They are two competing engines and you pick one
D. BuildKit only builds multi-arch images and Buildx only builds single-arch images

<details>
<summary>Answer</summary>

**A.** BuildKit is the build engine and Buildx is the CLI front end that sends builds to it

Buildx drives BuildKit. Neither is tied to single- or multi-arch builds, and they aren't alternatives to each other.

</details>

**2. Why do NICo's `images-dev` builds avoid custom Buildx builders?**

A. So intermediate compiler and runtime images stay in the daemon's image store for the next build, without a registry
B. Because custom builders can't build Rust
C. Because custom builders always push to Docker Hub
D. Because custom builders don't support BuildKit

<details>
<summary>Answer</summary>

**A.** So intermediate compiler and runtime images stay in the daemon's image store for the next build, without a registry

The built-in builder writes into and reads from the daemon's image store, and the docs say intermediate images remain available to the following service build without a registry. Custom builders can build Rust and do use BuildKit. They just keep their own separate store.

</details>

**3. Which environment variable selects the Buildx builder?**

A. BUILDX_BUILDER
B. DOCKER_HOST
C. IMAGE_REGISTRY
D. NICO_ARCHES

<details>
<summary>Answer</summary>

**A.** BUILDX_BUILDER

`BUILDX_BUILDER` picks the builder and `DOCKER_CONTEXT` picks the context. `DOCKER_HOST` sets a daemon address. The other two are NICo Makefile variables.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

<a id="building-local-dev-images"></a>
## 5. Building local dev images (make images-dev)

*Builds on: Docker BuildKit and Buildx (ch. 13), Build host bootstrap (make bootstrap) (ch. 13)*

### Before you read

- After `make images-dev DEV_TARGET=dhcp`, is the image in `localhost:5000` or loaded into a kind cluster?
- Your Docker daemon is arm64. Does `make images-dev` build arm64, amd64 or both?

<details>
<summary>Answers</summary>

- **After `make images-dev DEV_TARGET=dhcp`, is the image in `localhost:5000` or loaded into a kind cluster?** Neither. It builds images in the selected Docker daemon only. It doesn't push, create a registry, load into kind or deploy.
- **Your Docker daemon is arm64. Does `make images-dev` build arm64, amd64 or both?** Only arm64. It reads the daemon's architecture from `docker info` and builds natively, with no emulation.

</details>

### Explanation

`make images-dev` is the fast inner loop: it builds **one** native NICo Core development service image using the same recipes as Tilt (NICo's dev-deployment tool). Run it from the repo root. You need Git, Make and a Docker client connected to a **Linux amd64 or arm64 daemon with BuildKit**. Compilers and runtime dependencies are built in containers, so you don't need the full bootstrap. A Mac with a Linux Docker daemon is fine.

```bash
make images-dev DEV_TARGET=dhcp
```

This builds three images in the daemon: a compiler image (`nico-dev-build:latest`), a shared runtime image (`nico-dev-runtime:latest`) and the service image (`nico-dev-dhcp:latest`). The shared recipes are `dev/docker/Dockerfile.dev-services` and `dev/docker/Dockerfile.dev-runtime`.

**Architecture.** The target reads the daemon's architecture from `docker info`, accepting `amd64`/`x86_64` and `arm64`/`aarch64`, and builds `linux/amd64` or `linux/arm64` to match. Anything else is rejected before building. It ignores `NICO_ARCHES` and never enables emulation. It also pins the context and built-in builder, as the previous lesson explained.

**Variables** (passed as `NAME=value`):

| Variable | Default |
|---|---|
| `DEV_TARGET` | `api`. Must be exactly one of `api`, `bmc-proxy`, `dhcp`, `machine-a-tron`, `ssh-console`, `mat-protocol-gateway`, `nico-postgres-exporter` |
| `IMAGE_TAG` | `latest` |
| `DEV_IMAGE` | `nico-dev-$(DEV_TARGET):$(IMAGE_TAG)` |
| `DEV_BUILD_CONTAINER` | `nico-dev-build:$(IMAGE_TAG)` |
| `DEV_RUNTIME_CONTAINER` | `nico-dev-runtime:$(IMAGE_TAG)` |

An explicitly supplied reference wins: changing `IMAGE_TAG` doesn't rewrite a `DEV_IMAGE` you set yourself. `IMAGE_REGISTRY` has no effect here.

**Caching.** Repeat builds reuse Docker layers and Cargo caches, kept separately per architecture. Old Tilt-only caches aren't pruned for you.

**Smoke test (DHCP).** The DHCP image packages the Kea DHCPv4 and DHCPv6 servers with NICo's hook at `/usr/lib/kea/hooks/libdhcp.so`, plus `iproute2` and `curl`. Check it with:

```bash
dev/docker/tests/smoke_dhcp_image.sh nico-dev-dhcp:latest
```

The script needs exactly one image reference (wrong argument count prints usage and exits 2). It runs a temporary `--network none` container, checks `ip`, `ss` and `curl`, starts each Kea server with the hook, confirms UDP listeners on IPv4 port 67 and IPv6 port 547, and exits non-zero on any failure. It doesn't test lease allocation.

**Analogy.** It's like test-baking a single cupcake in your own oven before catering a wedding. It's quick, it uses the real recipe, and nothing leaves your kitchen. The analogy breaks down because the dev image is a separate product from the release stack built by `make images`, not a smaller copy of the same thing.

### Worked example: Build and smoke-test the DHCP dev image

**Step 1: Confirm the daemon is a supported Linux architecture.**

```sh
docker info --format '{{.OSType}} {{.Architecture}}'   # linux x86_64  or  linux aarch64
```

**Step 2: Build the service.**

```sh
cd infra-controller
make images-dev DEV_TARGET=dhcp
```
The first run is slow because the compiler image and Cargo caches start cold.

**Step 3: See what was produced.**

```sh
docker images | grep -E 'nico-dev-(build|runtime|dhcp)'
```
You should see three images tagged `latest`, and no push output.

**Step 4: Smoke-test it.**

```sh
dev/docker/tests/smoke_dhcp_image.sh nico-dev-dhcp:latest
echo "exit: $?"   # 0 on success, with a success line for each IP family
```

**Step 5: Rebuild to see caching.**

Edit nothing and run `make images-dev DEV_TARGET=dhcp` again. Layers and Cargo caches are reused, so it finishes much faster.

### Your turn: finish it

You want the API dev image tagged for pull request 42, so the result is `nico-dev-api:pr42` (and the compiler and runtime images are also tagged `pr42`). Fill in the blanks.

```text
make images-dev DEV_TARGET=___ IMAGE_TAG=___
```

<details>
<summary>Answer</summary>

make images-dev DEV_TARGET=api IMAGE_TAG=pr42

</details>

### Your turn: on your own

You run `make images-dev DEV_TARGET=dhcp IMAGE_TAG=x DEV_IMAGE=dhcp-test:try1`. List the three image references produced, then write the smoke-test command for the service image.

<details>
<summary>Hint 1</summary>

Two of the three references are built from `IMAGE_TAG`.

</details>

<details>
<summary>Hint 2</summary>

Does `IMAGE_TAG` change a reference you set explicitly?

</details>

<details>
<summary>Hint 3</summary>

The smoke script takes exactly one argument: the service image you actually built.

</details>

<details>
<summary>Answer</summary>

Compiler: `nico-dev-build:x`. Runtime: `nico-dev-runtime:x`. Service: `dhcp-test:try1`, because explicit references take precedence and `IMAGE_TAG` doesn't rewrite them. Smoke test: `dev/docker/tests/smoke_dhcp_image.sh dhcp-test:try1`.

</details>

### Explain it

In your own words: Why does `make images-dev` refuse to emulate a different architecture, even though `make images` builds for both?

### Check

**1. What happens with `make images-dev DEV_TARGET=pxe`?**

A. It's rejected, because `pxe` isn't one of the allowed DEV_TARGET values
B. It builds `nico-dev-pxe:latest`
C. It silently falls back to `api`
D. It builds every service

<details>
<summary>Answer</summary>

**A.** It's rejected, because `pxe` isn't one of the allowed DEV_TARGET values

DEV_TARGET must be exactly one of api, bmc-proxy, dhcp, machine-a-tron, ssh-console, mat-protocol-gateway or nico-postgres-exporter. Other values are rejected, not quietly replaced.

</details>

**2. You run `dev/docker/tests/smoke_dhcp_image.sh` with no arguments. What happens?**

A. It prints usage and exits with status 2
B. It tests `nico-dev-dhcp:latest` by default
C. It builds the image first
D. It exits 0 because nothing failed

<details>
<summary>Answer</summary>

**A.** It prints usage and exits with status 2

The script requires exactly one image reference. Missing or extra arguments print usage and exit 2.

</details>

**3. You set `IMAGE_REGISTRY=my-registry.example.com/nico` on an `images-dev` run. What changes?**

A. Nothing: `IMAGE_REGISTRY` doesn't affect images-dev
B. Images are pushed to that registry
C. Image names get that prefix but aren't pushed
D. The build fails

<details>
<summary>Answer</summary>

**A.** Nothing: `IMAGE_REGISTRY` doesn't affect images-dev

The docs state that `IMAGE_REGISTRY` doesn't affect this target. images-dev never pushes.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

<a id="cross-architecture-emulation"></a>
## 6. Cross-architecture emulation (binfmt/QEMU)

*Builds on: Docker BuildKit and Buildx (ch. 13), CPU architectures (amd64 vs arm64) (ch. 1)*

### Before you read

- On an x86_64 laptop, what do you expect `docker run --rm --platform linux/arm64 alpine uname -m` to do?
- Is compiling Rust inside an emulated arm64 container on an x86 machine as fast as a native build?

<details>
<summary>Answers</summary>

- **On an x86_64 laptop, what do you expect `docker run --rm --platform linux/arm64 alpine uname -m` to do?** If QEMU emulation is registered with binfmt_misc, it prints `aarch64`. Without it, the container fails with `exec format error`.
- **Is compiling Rust inside an emulated arm64 container on an x86 machine as fast as a native build?** No. Every instruction is translated in software, so heavy builds can be many times slower.

</details>

### Explanation

A compiled binary contains machine code for **one** instruction set. An aarch64 ELF file means nothing to an x86_64 CPU. So how does an x86 build host produce and test arm64 images?

**binfmt_misc** is a Linux kernel feature that maps file formats to interpreters. A registration says, roughly, "if an executable's header matches the ELF magic bytes for aarch64, run it through `/usr/bin/qemu-aarch64`." **QEMU user-mode emulation** then translates the program's arm64 instructions to x86 instructions on the fly and passes its system calls to the host kernel. The kernel is still the host's. Only user-space code is emulated.

Containers share the host kernel, so once the registration exists, any arm64 container, including the `RUN` steps of an arm64 Docker build, runs transparently. The `tonistiigi/binfmt` image installs these registrations. NICo's bootstrap runs a pinned digest of it:

```sh
sudo docker run --privileged --rm tonistiigi/binfmt@sha256:400a4873... --install all
```

`--install all` registers emulators for every architecture it supports. Registrations appear under `/proc/sys/fs/binfmt_misc/`, e.g. `qemu-aarch64`. Docker Desktop ships with this already set up.

**The costs:** emulation is slow, especially for CPU-heavy work like compiling Rust, and an occasional program behaves differently under emulation.

**How NICo uses it:**

- `make images` and `make images-all` build both amd64 and arm64 by default. The non-native one uses the platforms configured on the active Buildx builder, which on a single-architecture host usually means QEMU.
- `make images-arm` and `make images-all-arm` **require an ARM64 Docker host** and stop before building on any other architecture. They build natively, so they don't use QEMU or binfmt.
- `make images-dev` builds only the daemon's native architecture and doesn't enable emulation.

**Analogy.** binfmt_misc is a receptionist who sees a letter written in Japanese and automatically routes it to the in-house interpreter (QEMU) before it reaches you. Everything works, just more slowly. The analogy breaks down because the interpreter only translates the program's own instructions. Requests to the kernel go straight through untranslated, which is why the host kernel still does all the real system work.

### Worked example: Register QEMU and run an arm64 container on an x86 host

**Step 1: Check your native architecture.**

```sh
uname -m                                  # x86_64
docker info --format '{{.Architecture}}'
```

**Step 2: Try a foreign-architecture container.**

```sh
docker run --rm --platform linux/arm64 alpine:3.20 uname -m
```
Without emulation: `exec format error`. With it: `aarch64`.

**Step 3: Register the emulators.**

```sh
docker run --privileged --rm tonistiigi/binfmt --install all
docker run --privileged --rm tonistiigi/binfmt   # prints JSON of supported platforms and emulators
ls /proc/sys/fs/binfmt_misc/ | grep qemu        # Linux host only
```

**Step 4: Run it again and inspect the registration.**

```sh
docker run --rm --platform linux/arm64 alpine:3.20 uname -m   # aarch64
cat /proc/sys/fs/binfmt_misc/qemu-aarch64   # 'enabled', interpreter path, magic bytes
```

**Step 5: Feel the cost.**

```sh
time docker run --rm --platform linux/amd64 alpine:3.20 sh -c 'i=0; while [ $i -lt 2000000 ]; do i=$((i+1)); done'
time docker run --rm --platform linux/arm64 alpine:3.20 sh -c 'i=0; while [ $i -lt 2000000 ]; do i=$((i+1)); done'
```
The emulated loop is noticeably slower. Scale that up to a full Rust workspace build.

### Your turn: finish it

On a fresh x86 Linux host, register just the arm64 emulator and then prove an arm64 container runs. Fill in the blanks.

```text
docker run --privileged --rm tonistiigi/binfmt --install ___
docker run --rm --platform linux/___ alpine:3.20 uname -m   # prints aarch64
```

<details>
<summary>Answer</summary>

docker run --privileged --rm tonistiigi/binfmt --install arm64
docker run --rm --platform linux/arm64 alpine:3.20 uname -m   # prints aarch64

(`--install all`, as NICo's bootstrap uses, also works.)

</details>

### Your turn: on your own

You have two build machines: an x86_64 Ubuntu host with binfmt registered, and an Ampere ARM64 Ubuntu host. You need the arm64 deployable stack and want to avoid emulation entirely. Which machine and which target do you use? What happens if someone runs that target on the x86 host?

<details>
<summary>Hint 1</summary>

Some targets refuse to run on the wrong architecture.

</details>

<details>
<summary>Hint 2</summary>

Look for the targets with an `-arm` suffix.

</details>

<details>
<summary>Hint 3</summary>

`make images-arm` builds the deployable stack natively on ARM64.

</details>

<details>
<summary>Answer</summary>

Use the ARM64 host and run `make images-arm`, which sets `NICO_ARCHES=arm64` and builds natively without QEMU/binfmt. On the x86 host the `-arm` target stops before building, because it requires an ARM64 Docker host. (For the full set including the DPU BFB image, `make images-all-arm`.)

</details>

### Explain it

In your own words: Why can a container's arm64 user-space programs run on an x86 host, when an arm64 *kernel* couldn't be loaded the same way?

### Check

**1. What does `make images-all-arm` do on an x86_64 Docker host?**

A. It stops before building, because it requires an ARM64 Docker host
B. It builds arm64 under QEMU emulation
C. It builds amd64 instead
D. It builds both architectures

<details>
<summary>Answer</summary>

**A.** It stops before building, because it requires an ARM64 Docker host

The `-arm` targets check the host architecture and refuse to fall back to emulation.

</details>

**2. Which piece of Linux makes the kernel hand an aarch64 binary to `qemu-aarch64` automatically?**

A. binfmt_misc
B. cgroups
C. AppArmor
D. user namespaces

<details>
<summary>Answer</summary>

**A.** binfmt_misc

binfmt_misc maps executable formats to interpreters. Cgroups limit resources, AppArmor confines programs, and user namespaces remap IDs. None of those run foreign binaries.

</details>

**3. Does `make images-dev` use QEMU to build amd64 on an arm64 daemon if you set `NICO_ARCHES=amd64`?**

A. No. It builds only the daemon's native architecture and ignores NICO_ARCHES
B. Yes, NICO_ARCHES switches it to emulation
C. Yes, but only for the DHCP image
D. It builds both architectures

<details>
<summary>Answer</summary>

**A.** No. It builds only the daemon's native architecture and ignores NICO_ARCHES

The docs state that architecture selection doesn't use `NICO_ARCHES` or enable cross-architecture emulation.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

<a id="multi-architecture-image-manifest"></a>
## 7. Multi-architecture image manifest

*Builds on: Container registry (ch. 13)*

### Before you read

- An arm64 node and an amd64 node both pull `nginx:latest`. Do they download the same bytes?
- NICo builds amd64 and arm64 images in separate steps and then joins them. Why not build both in one command?

<details>
<summary>Answers</summary>

- **An arm64 node and an amd64 node both pull `nginx:latest`. Do they download the same bytes?** No. The tag points to an index listing one image per platform, and each client picks the entry that matches its own CPU.
- **NICo builds amd64 and arm64 images in separate steps and then joins them. Why not build both in one command?** The docs say a single combined Buildx invocation could reuse one builder stage and copy an amd64 binary into the arm64 image, which happens with the REST Dockerfiles. Separate builds avoid that.

</details>

### Explanation

A plain **image manifest** describes one image: a config blob and a list of layer blobs, all for one platform. To let one tag serve several CPU architectures, registries support an **image index** (OCI's name; Docker calls it a **manifest list**). It's a small JSON document whose `manifests` array points to per-platform manifests:

```json
{
  "mediaType": "application/vnd.oci.image.index.v1+json",
  "manifests": [
    {"digest": "sha256:aaa...", "platform": {"os": "linux", "architecture": "amd64"}},
    {"digest": "sha256:bbb...", "platform": {"os": "linux", "architecture": "arm64"}},
    {"digest": "sha256:ccc...", "platform": {"os": "unknown", "architecture": "unknown"}}
  ]
}
```

A pulling client reads the index and fetches only the entry for its platform. Entries marked `unknown/unknown` are usually build **attestations** (provenance or SBOM data that Buildx can attach), not runnable images. That's why NICo's verification loop keeps only `os == "linux"` entries.

Useful commands:

- `docker buildx imagetools create -t <target> <src1> <src2>` builds an index in the registry from existing images.
- `docker buildx imagetools inspect <ref>` prints a readable summary. Add `--raw` for the JSON.

**NICo's approach.** Every architecture is built **separately**, producing `-amd64` and `-arm64` tags, and the bare tag (e.g. `nico:latest`) is then assembled from them. This matches CI and is **required for the REST Dockerfiles**: one combined Buildx invocation would reuse one builder stage and could copy an amd64 binary into the arm64 image. That image would carry an arm64 label but fail to run on arm64. The architecture-specific tags are build inputs for the bare multi-arch tags.

A single-architecture build still produces a valid tag. Its index simply has one entry.

**Analogy.** A multi-arch tag is like the menu entry "Soup of the day". The kitchen serves a vegan or a regular version depending on who ordered, while the menu entry stays the same. The analogy breaks down because there's no waiter judging you: your client declares its platform and picks the matching entry itself, so a mislabelled entry is served without question.

### Worked example: Assemble a two-architecture tag from per-arch tags

**Step 1: Prerequisites.**

QEMU registered (previous lesson) and a fresh local registry on `localhost:5000`:
```sh
docker rm -f lab-registry 2>/dev/null || true
docker run -d -p 5000:5000 --name lab-registry registry:2
```
(If port 5000 is taken, by AirPlay on macOS or a running `nico-build-registry`, use `-p 5001:5000` and `localhost:5001` throughout.)

**Step 2: Build and push each architecture separately.**

```sh
mkdir mademo && cd mademo
printf 'FROM alpine:3.20\nCMD ["uname", "-m"]\n' > Dockerfile
for arch in amd64 arm64; do
  docker build --platform linux/$arch -t localhost:5000/mademo:latest-$arch .
  docker push localhost:5000/mademo:latest-$arch
done
```

**Step 3: Assemble the bare tag.**

```sh
docker buildx imagetools create -t localhost:5000/mademo:latest \
  localhost:5000/mademo:latest-amd64 localhost:5000/mademo:latest-arm64
```

**Step 4: Inspect the index.**

```sh
docker buildx imagetools inspect localhost:5000/mademo:latest
docker buildx imagetools inspect --raw localhost:5000/mademo:latest | \
  jq -r '[.manifests[].platform | select(.os == "linux") | "\(.os)/\(.architecture)"] | unique | sort | join(",")'
# linux/amd64,linux/arm64
```

**Step 5: Pull each platform, then clean up.**

```sh
docker run --rm --pull always --platform linux/amd64 localhost:5000/mademo:latest   # x86_64
docker run --rm --pull always --platform linux/arm64 localhost:5000/mademo:latest   # aarch64
docker rm -f lab-registry
```

### Your turn: finish it

Combine the per-arch tags into `localhost:5000/hello:latest`, then print each Linux platform it contains. Fill in the blanks.

```text
docker buildx imagetools create \
  -t localhost:5000/hello:latest \
  localhost:5000/hello:latest-___ \
  localhost:5000/hello:latest-arm64
docker buildx imagetools inspect --raw localhost:5000/hello:latest | \
  jq -r '.manifests[].platform | select(.os == "linux") | "\(.os)/\(.___)"'
```

<details>
<summary>Answer</summary>

docker buildx imagetools create \
  -t localhost:5000/hello:latest \
  localhost:5000/hello:latest-amd64 \
  localhost:5000/hello:latest-arm64
docker buildx imagetools inspect --raw localhost:5000/hello:latest | \
  jq -r '.manifests[].platform | select(.os == "linux") | "\(.os)/\(.architecture)"'

</details>

### Your turn: on your own

`imagetools inspect --raw` for `localhost:5000/nico-rest-api:latest` returns an index whose `manifests` have these platforms: `linux/arm64`, `unknown/unknown`, `linux/amd64`, `unknown/unknown`. What string does NICo's jq filter `[.manifests[].platform | select(.os == "linux") | "\(.os)/\(.architecture)"] | unique | sort | join(",")` produce, and would it PASS with the default `NICO_ARCHES`?

<details>
<summary>Hint 1</summary>

`select(.os == "linux")` drops some entries.

</details>

<details>
<summary>Hint 2</summary>

`unique` and `sort` put the result in alphabetical order.

</details>

<details>
<summary>Hint 3</summary>

The default NICO_ARCHES is `amd64 arm64`, which becomes `linux/amd64,linux/arm64`.

</details>

<details>
<summary>Answer</summary>

`linux/amd64,linux/arm64`. The two `unknown/unknown` attestation entries are filtered out and the rest are sorted. The expected value for the default `NICO_ARCHES="amd64 arm64"` is also `linux/amd64,linux/arm64`, so it PASSes.

</details>

### Explain it

In your own words: Why is an index entry labelled `linux/arm64` that contains an amd64 binary worse than a build that simply fails?

### Check

**1. Why does NICo build each architecture separately before assembling the bare tag?**

A. A single combined Buildx invocation could reuse one builder stage and copy an amd64 binary into the arm64 image
B. Registries can't store two architectures under one tag
C. Buildx can't build for more than one platform at all
D. To save disk space

<details>
<summary>Answer</summary>

**A.** A single combined Buildx invocation could reuse one builder stage and copy an amd64 binary into the arm64 image

That's the documented reason, tied to the REST Dockerfiles. Registries do support multi-platform indexes, and Buildx can build several platforms at once. NICo avoids that for correctness.

</details>

**2. What do you get from a single-architecture build with `NICO_ARCHES=amd64`?**

A. A valid tag whose manifest has a single entry
B. No bare tag, only `-amd64` tags
C. An error, because multi-arch tags need two entries
D. An arm64 entry produced by emulation

<details>
<summary>Answer</summary>

**A.** A valid tag whose manifest has a single entry

The docs say a single-architecture build still produces a valid tag at `$(IMAGE_TAG)`, with one entry in the multi-arch manifest.

</details>

**3. Why does NICo's verification jq keep only entries with `os == "linux"`?**

A. To skip non-image entries such as attestations, which are labelled `unknown/unknown`
B. Because Windows images are automatically added
C. Because `os` is the only field present
D. To remove duplicate amd64 entries

<details>
<summary>Answer</summary>

**A.** To skip non-image entries such as attestations, which are labelled `unknown/unknown`

Buildx can attach attestation manifests with an unknown platform. Counting them would break the platform comparison. Nothing adds Windows images, and `unique` handles duplicates separately.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

<a id="building-all-images"></a>
## 8. Building all images (make images)

*Builds on: Multi-architecture image manifest (ch. 13), Build host bootstrap (make bootstrap) (ch. 13), Docker BuildKit and Buildx (ch. 13)*

### Before you read

- How many image tags do you think make up NICo's 'deployable stack' (Core plus REST)? Take a guess.
- After a build finishes without errors, what could still be wrong with the images in the registry?

<details>
<summary>Answers</summary>

- **How many image tags do you think make up NICo's 'deployable stack' (Core plus REST)? Take a guess.** 11: `nico` (Core) plus 10 REST-side images (`nico-rest-api`, `nico-rest-workflow`, `nico-rest-site-manager`, `nico-rest-site-agent`, `nico-rest-db`, `nico-rest-cert-manager`, `nico-flow`, `nico-psm`, `nico-nsm`, `nico-mcp`).
- **After a build finishes without errors, what could still be wrong with the images in the registry?** A tag could be missing an architecture, so its manifest is incomplete. That's why NICo gives you a loop that checks each tag's platforms.

</details>

### Explanation

On a bootstrapped host, one `make` command builds and **pushes** images. Unlike `images-dev`, these targets publish to a registry:

```sh
make images          # deployable stack: NICo Core (nico) + REST service images (11)
make images-arm      # deployable stack for ARM64, built natively on ARM64
make images-all      # + machine-validation + both boot-artifact images (14)
make images-all-arm  # 13 native ARM64 outputs; omits boot-artifacts-x86_64
```

Registry and tag come from `IMAGE_REGISTRY` (default `localhost:5000`) and `IMAGE_TAG` (default `latest`).

**Architecture variables.** Each image group builds `amd64 arm64` by default and has its own override:

- `NICO_ARCHES`: control-plane images (`images-base`, `images-core`, `images-rest`, `images-machine-validation`)
- `BOOT_ARTIFACTS_ARCHES`: the x86 boot-artifact image (`images-boot-artifacts`)
- `DPU_ARCHES`: the DPU BFB boot-artifact image (`images-bfb`)

`images-arm` sets `NICO_ARCHES=arm64`. `images-all-arm` sets `NICO_ARCHES=arm64` and `DPU_ARCHES=arm64`. Values other than `amd64`/`arm64` fail fast. Example: `make images-all NICO_ARCHES=amd64 DPU_ARCHES=arm64`.

**A trap.** `images-machine-validation` requires `NICO_ARCHES` to include `amd64`, because its `machine-validation-runner` intermediate is built for amd64 on the amd64 Core runtime base. `NICO_ARCHES=arm64` alone fails fast for that target. Use `images-machine-validation-arm` on ARM64. The QA-only `make images-machine-lifecycle` is separate and isn't part of `images-all`.

**Verifying.** The docs provide a bash loop that checks each image. It runs `docker buildx imagetools inspect --raw` with the jq filter from the previous lesson and compares the result with the expected platforms. Boot-artifact images are compared against `BOOT_ARTIFACTS_ARCHES` and `DPU_ARCHES`, everything else against `NICO_ARCHES`. It prints `PASS <image>: <platforms>` or exits on the first `FAIL`. Before running it, **set the same `IMAGE_REGISTRY`, `IMAGE_TAG` and `*_ARCHES` values you passed to make**, because the loop falls back to the Makefile defaults. Set `ARM_ONLY=1` after `images-all-arm`. Expect **14 PASS lines** after `images-all` and **13** after `images-all-arm`. The loop lists all 14 images, so after plain `make images` you'd trim the list to the 11 stack images.

For debugging one image, `make help` lists the individual targets (`images-core`, `images-rest`, `images-bfb`, …), and the manual documents the raw `docker build` commands they wrap.

**Analogy.** It's like a moving company's checklist: pack everything, load the truck (push), then walk through the inventory sheet ticking off each box (the PASS loop). The analogy breaks down because the inventory sheet is only right if you tell it what you ordered. If the loop's variables don't match your build, it reports false failures.

### Worked example: Build amd64 control plane with an arm64 BFB, then verify

**Step 1: Decide the variables.**

The target cluster nodes are amd64 and the DPUs need the BFB image. The x86 boot artifacts use the default `amd64 arm64`.
```sh
export IMAGE_REGISTRY=localhost:5000 IMAGE_TAG=latest
export NICO_ARCHES=amd64 DPU_ARCHES=arm64
```

**Step 2: Build and push.**

```sh
make images-all NICO_ARCHES=amd64 DPU_ARCHES=arm64
```
The Makefile starts `nico-build-registry` because the default registry is in use.

**Step 3: Run the verification loop in the same shell.**

Paste the loop from the manual into `verify-images.sh` and run it with the exported variables still set (`ARM_ONLY` left unset):
```sh
bash verify-images.sh
```

**Step 4: Read the output.**

Expect 14 lines such as:
```
PASS nico: linux/amd64
PASS nico-rest-api: linux/amd64
...
PASS boot-artifacts-x86_64: linux/amd64,linux/arm64
PASS boot-artifacts-aarch64: linux/arm64
```

**Step 5: Debug a FAIL.**

A line like `FAIL nico-flow: got linux/amd64, want linux/amd64,linux/arm64` names the incomplete image. Check that you exported the same `NICO_ARCHES` you built with. If you did, rebuild just that group (`make help` lists `images-rest`).

### Your turn: finish it

You ran `make images-all-arm IMAGE_REGISTRY=reg.lab/nico IMAGE_TAG=v1.0.0`. Fill in the environment for the verification loop so it checks the right 13 images against the right registry.

```text
export IMAGE_REGISTRY=___
export IMAGE_TAG=v1.0.0
export ARM_ONLY=___
bash verify-images.sh   # expect ___ PASS lines
```

<details>
<summary>Answer</summary>

export IMAGE_REGISTRY=reg.lab/nico
export IMAGE_TAG=v1.0.0
export ARM_ONLY=1
bash verify-images.sh   # expect 13 PASS lines

</details>

### Your turn: on your own

Your whole site (control plane, x86 boot artifacts and the BFB container image) should be amd64-only, published to `reg.lab/nico` with tag `v1.2.0`, including machine-validation and both boot-artifact images. Write the full command, including anything you must do before it.

<details>
<summary>Hint 1</summary>

Which target includes machine-validation and both boot-artifact images?

</details>

<details>
<summary>Hint 2</summary>

There are three separate architecture variables, one per image group.

</details>

<details>
<summary>Hint 3</summary>

Log in first, then `make images-all` with all three `*_ARCHES=amd64` and the registry/tag variables.

</details>

<details>
<summary>Answer</summary>

`docker login reg.lab`, then `make images-all NICO_ARCHES=amd64 BOOT_ARTIFACTS_ARCHES=amd64 DPU_ARCHES=amd64 IMAGE_REGISTRY=reg.lab/nico IMAGE_TAG=v1.2.0`. This is valid because `NICO_ARCHES` includes amd64, which machine-validation requires. Export the same values before running the verification loop, which should print 14 PASS lines, each showing `linux/amd64`.

</details>

### Explain it

In your own words: Why does the verification loop have to use the same `*_ARCHES`, registry and tag values as the build, and what does a mismatch look like?

### Check

**1. What happens with `make images-machine-validation NICO_ARCHES=arm64`?**

A. It fails fast, because the runner image needs amd64 in NICO_ARCHES
B. It builds an arm64 machine-validation image
C. It silently builds amd64 instead
D. It builds under QEMU

<details>
<summary>Answer</summary>

**A.** It fails fast, because the runner image needs amd64 in NICO_ARCHES

The compatibility target's `machine-validation-runner` is built for amd64 on the amd64 Core runtime base. Use `images-machine-validation-arm` for native ARM64.

</details>

**2. Which target builds only the 11-image deployable stack for both architectures?**

A. make images
B. make images-all
C. make images-dev
D. make images-all-arm

<details>
<summary>Answer</summary>

**A.** make images

`images-all` adds machine-validation and boot artifacts (14). `images-dev` builds one dev service without pushing. `images-all-arm` is ARM64-only with 13 outputs.

</details>

**3. Which image does `images-all-arm` NOT produce?**

A. boot-artifacts-x86_64
B. boot-artifacts-aarch64
C. machine-validation
D. nico-rest-api

<details>
<summary>Answer</summary>

**A.** boot-artifacts-x86_64

`images-all-arm` publishes the 11 service images, the ARM64 machine-validation image and the DPU BFB image (`boot-artifacts-aarch64`), and omits the x86 boot-artifact image.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md)

<a id="boot-artifacts"></a>
## 9. Boot artifacts

*Builds on: PXE / iPXE boot (ch. 12)*

### Before you read

- A server PXE/iPXE-boots with nothing installed on its disk. What files does something on the network have to give it?
- These files are kernels and disk images, not services. Why would NICo put them inside container images?

<details>
<summary>Answers</summary>

- **A server PXE/iPXE-boots with nothing installed on its disk. What files does something on the network have to give it?** A bootloader (e.g. an iPXE binary), boot scripts, then a kernel and initial ramdisk or full OS image to run. Together these are the 'boot artifacts'.
- **These files are kernels and disk images, not services. Why would NICo put them inside container images?** Containers are already NICo's unit of versioning and delivery. Boot files tagged and pushed alongside the services are versioned with them, and Kubernetes can pull them like any other image.

</details>

### Explanation

Chapter 12 showed hosts and DPUs PXE/iPXE-booting from the network. Whatever they download has to be built somewhere. **Boot artifacts** are the OS images and binaries that NICo serves to network-booting hosts and DPUs. The glossary notes that NICo runs its own PXE server to serve images shipped with the software, such as DPU software and iPXE.

They're built with two tools, which is why the bootstrap installs them:

- **mkosi**, a systemd-project tool that builds bootable OS images from distribution packages. The bootstrap also installs `systemd-boot` and `systemd-ukify`, used for UEFI boot images.
- **iPXE**, the network bootloader, built from source.

Both come in as **git submodules**, and building them needs the full mkosi + Rust toolchain. That's why the docs say the boot and validation images require a bootstrapped Ubuntu host.

The build has two phases. First, a cargo-make task in `pxe/` produces the files on the host:

```sh
cargo make --cwd pxe --env SA_ENABLEMENT=1 build-boot-artifacts-x86-host-sa
```

Then a thin container packages them:

```sh
docker build --build-arg "CONTAINER_RUNTIME_X86_64=alpine:latest" \
  -t boot-artifacts-x86_64 -f dev/docker/Dockerfile.release-artifacts-x86_64 .
```

The `CONTAINER_RUNTIME_X86_64` build argument picks the base image, here a small `alpine:latest`. The container is mostly a delivery vehicle for files, so it doesn't need a heavy runtime.

In the full build this is `images-boot-artifacts` (part of `images-all`), and its architectures come from `BOOT_ARTIFACTS_ARCHES`. Machine validation is packaged in a similar way. The `machine-validation-runner` image is saved as a tar and copied into `/images` in the `machine-validation-config` container. In a Kubernetes deployment, that is the machine-validation container configured on the `nico-pxe` pod.

**Analogy.** Boot artifacts in a container are like a toolbox shipped in a standard shipping container. The container isn't the tool, but every port (registry, Kubernetes) already knows how to move, label and track it. The analogy breaks down because the contents might be for a completely different machine: the box's 'architecture' label says nothing about the CPU the payload runs on (next lesson).

### Worked example: Package boot files into a container and get them back out

**Step 1: Create fake artifacts.**

```sh
mkdir -p artdemo/artifacts && cd artdemo
printf '#!ipxe\necho booting demo\nshell\n' > artifacts/boot.ipxe
head -c 1048576 /dev/urandom > artifacts/fake-rootfs.img
```

**Step 2: Write a parameterised packaging Dockerfile.**

```dockerfile
ARG CONTAINER_RUNTIME=alpine:latest
FROM ${CONTAINER_RUNTIME}
COPY artifacts/ /artifacts/
```
Save it as `Dockerfile.artifacts`. The `ARG` before `FROM` lets the caller choose the base image, the same idea as NICo's `CONTAINER_RUNTIME_X86_64`.

**Step 3: Build it.**

```sh
docker build --build-arg CONTAINER_RUNTIME=alpine:3.20 \
  -f Dockerfile.artifacts -t boot-artifacts-demo .
docker run --rm boot-artifacts-demo ls -l /artifacts
```

**Step 4: Extract without running anything.**

```sh
docker create --name art boot-artifacts-demo
docker cp art:/artifacts ./extracted
docker rm art
cmp artifacts/fake-rootfs.img extracted/fake-rootfs.img && echo identical
```

**Step 5: Serve them like a PXE/HTTP boot server would.**

Alpine's busybox doesn't include the `httpd` applet, so serve the extracted files from a `busybox:stable` container, which does:
```sh
docker run --rm -d --name artsrv -p 8080:8080 \
  -v "$PWD/extracted:/artifacts:ro" busybox:stable httpd -f -p 8080 -h /artifacts
curl -s http://localhost:8080/boot.ipxe     # prints the iPXE script
docker stop artsrv
```
This is the job NICo's PXE service does for real hosts, using artifacts it pulls from the boot-artifact image.

### Your turn: finish it

Complete the packaging Dockerfile so the base image is chosen at build time and the files in `./artifacts` end up in `/artifacts`.

```text
ARG CONTAINER_RUNTIME=alpine:latest
FROM ___
COPY artifacts/ ___
```

<details>
<summary>Answer</summary>

ARG CONTAINER_RUNTIME=alpine:latest
FROM ${CONTAINER_RUNTIME}
COPY artifacts/ /artifacts/

</details>

### Your turn: on your own

Your mkosi build wrote its output to `./out`. Write a Dockerfile and a `docker build` command that package `./out` into `/artifacts` in an image called `boot-artifacts-test`, based on `alpine:3.20` chosen by build argument. Then show a command that lists the packaged files.

<details>
<summary>Hint 1</summary>

Reuse the ARG-before-FROM pattern.

</details>

<details>
<summary>Hint 2</summary>

The COPY source is now `out/`.

</details>

<details>
<summary>Hint 3</summary>

`docker build --build-arg CONTAINER_RUNTIME=alpine:3.20 -f <file> -t boot-artifacts-test .`, then `docker run --rm boot-artifacts-test ls -R /artifacts`.

</details>

<details>
<summary>Answer</summary>

Dockerfile:
```dockerfile
ARG CONTAINER_RUNTIME=alpine:latest
FROM ${CONTAINER_RUNTIME}
COPY out/ /artifacts/
```
Build: `docker build --build-arg CONTAINER_RUNTIME=alpine:3.20 -f Dockerfile.artifacts -t boot-artifacts-test .`
List: `docker run --rm boot-artifacts-test ls -R /artifacts` (or `docker create` plus `docker cp` if you'd rather not run it).

</details>

### Explain it

In your own words: Why does it help to version and ship boot artifacts as container images in the same registry as NICo's services, instead of copying files to the PXE server by hand?

### Check

**1. Which two tools, pulled in as git submodules, are used to build NICo's boot artifacts?**

A. mkosi and iPXE
B. Helm and kustomize
C. rustup and sccache
D. Kea and Unbound

<details>
<summary>Answer</summary>

**A.** mkosi and iPXE

The bootstrap's submodule step pulls in the mkosi and iPXE sources. Helm and kustomize deploy, rustup and sccache are Rust tooling, and Kea and Unbound are DHCP and DNS servers.

</details>

**2. In `--build-arg CONTAINER_RUNTIME_X86_64=alpine:latest`, what does the build argument control?**

A. The base image the artifact files are packaged into
B. The CPU architecture of the kernel being built
C. The registry the image is pushed to
D. The iPXE version

<details>
<summary>Answer</summary>

**A.** The base image the artifact files are packaged into

It names the runtime/base container. The artifacts themselves were already built by the cargo-make step. The registry comes from make variables.

</details>

**3. Which variable sets the architectures of the `boot-artifacts-x86_64` image in `make images-all`?**

A. BOOT_ARTIFACTS_ARCHES
B. NICO_ARCHES
C. DPU_ARCHES
D. IMAGE_TAG

<details>
<summary>Answer</summary>

**A.** BOOT_ARTIFACTS_ARCHES

Each group has its own variable: NICO_ARCHES for control-plane images, DPU_ARCHES for the BFB image, BOOT_ARTIFACTS_ARCHES for the x86 boot artifacts.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="dpu-bfb"></a>
## 10. DPU BFB

*Builds on: BlueField DPU (ch. 7), Boot artifacts (ch. 13)*

### Before you read

- The BlueField DPU has Arm cores. The NICo BFB image is named `boot-artifacts-aarch64`. Guess its Docker image platform.
- What do you think a BFB file contains?

<details>
<summary>Answers</summary>

- **The BlueField DPU has Arm cores. The NICo BFB image is named `boot-artifacts-aarch64`. Guess its Docker image platform.** By default it's published for both linux/amd64 and linux/arm64 (DPU_ARCHES). The docs note that the aarch64 binaries are bundled into an x86 container. The container platform and the payload's CPU are different things.
- **What do you think a BFB file contains?** A BlueField bootstream: a bundle used to install or update the DPU's operating system and firmware.

</details>

### Explanation

From Chapter 7: a BlueField DPU is a NIC with its own Arm processor, OS and BMC, and you can reach it through interfaces such as rshim. NICo is responsible for installing the DPU OS and DPU firmware. It does this with a **BFB (BlueField bootstream)**, the image format used to install or update the operating system and firmware bundle on a BlueField DPU. The DPU's cores are Arm, so the OS and binaries inside are **aarch64**.

NICo builds the BFB as its **aarch64 boot artifact**, using the same two-phase pattern as the x86 boot artifacts:

```sh
cargo make --cwd pxe --env SA_ENABLEMENT=1 build-boot-artifacts-bfb-sa

docker build --build-arg "CONTAINER_RUNTIME_AARCH64=alpine:latest" \
  -t boot-artifacts-aarch64 -f dev/docker/Dockerfile.release-artifacts-aarch64 .
```

The docs flag that `CONTAINER_RUNTIME_AARCH64=alpine:latest` **must** be included, and that **the aarch64 binaries are bundled into an x86 container**. This is the key idea of the lesson: **image platform ≠ payload architecture.** The container's platform decides which cluster nodes can pull and run the container, such as the `nico-pxe` pods on x86 control-plane nodes. The payload is just files the container hands out to DPUs. The x86 node never executes them.

In the full build:

- `images-bfb` builds it, with container platforms from `DPU_ARCHES` (default `amd64 arm64`).
- `images-bfb-arm` builds it natively on ARM64. `images-all-arm` includes it.
- The native ARM DPU artifact build omits the deployment-local `carbide-pxe.forge` package source, so the build doesn't depend on that service being reachable.
- The verification loop checks `boot-artifacts-aarch64` against `DPU_ARCHES`.

The BFB comes back later in the course: `bf.cfg` parameters (ch. 28), DPU reprovisioning (ch. 27) and the Preingestion Manager (ch. 38) all build on it.

**Analogy.** It's like a US courier delivering a parcel of Japanese-language manuals. The courier (x86 container) has to work in the US, but the contents only need to be readable by the Japanese recipient (the DPU's Arm cores). The analogy breaks down because a real mislabelled parcel can be caught at the door, while nothing checks this one. If the payload is the wrong architecture, nothing complains until the DPU tries to boot it.

### Worked example: Ship an aarch64 payload inside an amd64 container

**Step 1: Get a real aarch64 binary as the payload.**

```sh
mkdir -p bfbdemo/payload && cd bfbdemo
docker create --platform linux/arm64 --name a64 busybox:stable
docker cp a64:/bin/busybox payload/busybox-aarch64
docker rm a64
file payload/busybox-aarch64   # ELF 64-bit LSB executable, ARM aarch64 ...
```

**Step 2: Write the packaging Dockerfile.**

```dockerfile
ARG CONTAINER_RUNTIME=alpine:latest
FROM ${CONTAINER_RUNTIME}
COPY payload/ /payload/
```
Save as `Dockerfile`. It has no `RUN` step, so building for any platform needs no emulation.

**Step 3: Build an amd64 container.**

```sh
docker build --platform linux/amd64 --build-arg CONTAINER_RUNTIME=alpine:3.20 -t bfb-demo .
docker image inspect --format '{{.Os}}/{{.Architecture}}' bfb-demo   # linux/amd64
```

**Step 4: Confirm the two architectures differ.**

```sh
docker run --rm --platform linux/amd64 bfb-demo uname -m          # x86_64 (the container)
docker run --rm --platform linux/amd64 bfb-demo ls -l /payload    # aarch64 file, never executed
```
On Apple Silicon these `run` commands use Docker Desktop's emulation for the amd64 container.

**Step 5: Relate it to NICo.**

This mirrors `boot-artifacts-aarch64`: aarch64 BFB contents inside a container whose platforms come from `DPU_ARCHES`, so x86 *and* arm64 cluster nodes can host it.

### Your turn: finish it

Build the demo container for amd64 and print its image architecture. Fill in the blanks.

```text
docker build --platform linux/___ --build-arg CONTAINER_RUNTIME=alpine:3.20 -t bfb-demo .
docker image inspect --format '{{.___}}' bfb-demo   # prints amd64
```

<details>
<summary>Answer</summary>

docker build --platform linux/amd64 --build-arg CONTAINER_RUNTIME=alpine:3.20 -t bfb-demo .
docker image inspect --format '{{.Architecture}}' bfb-demo   # prints amd64

</details>

### Your turn: on your own

A colleague reviews the verification output `PASS boot-artifacts-aarch64: linux/amd64,linux/arm64` and says: "Half of that is wrong. The DPU is Arm, so the amd64 entry is a bug." Reply to them.

<details>
<summary>Hint 1</summary>

What does the platform in a manifest entry describe: the container or the files inside it?

</details>

<details>
<summary>Hint 2</summary>

Which machines actually pull and run this container?

</details>

<details>
<summary>Hint 3</summary>

The docs say the aarch64 binaries are bundled into an x86 container, and DPU_ARCHES defaults to amd64 arm64.

</details>

<details>
<summary>Answer</summary>

It isn't a bug. The manifest platforms describe the container image, meaning which cluster nodes can pull and run it. The BFB payload inside is aarch64 in both variants, because it's delivered to the DPU and runs there, not on the node. The docs state that the aarch64 binaries are bundled into an x86 container, and `DPU_ARCHES` defaults to `amd64 arm64`, so the expected result is `linux/amd64,linux/arm64`. Narrow `DPU_ARCHES` if you only need one.

</details>

### Explain it

In your own words: Why must you keep 'the architecture the container runs on' and 'the architecture of the files it carries' separate when you think about NICo's BFB image?

### Check

**1. What is a BFB?**

A. The BlueField bootstream image format used to install or update the OS and firmware on a BlueField DPU
B. A BGP forwarding table for the DPU
C. The BMC firmware of the host server
D. A Buildx builder file

<details>
<summary>Answer</summary>

**A.** The BlueField bootstream image format used to install or update the OS and firmware on a BlueField DPU

That's the glossary definition. The other options mix up unrelated terms from earlier chapters.

</details>

**2. Why does the BFB container build pass `CONTAINER_RUNTIME_AARCH64=alpine:latest`?**

A. The aarch64 binaries are bundled into an x86 container, and this argument sets that container's base
B. It switches the DPU's Arm cores to x86 mode
C. It enables QEMU emulation during the build
D. It sets the registry for the DPU

<details>
<summary>Answer</summary>

**A.** The aarch64 binaries are bundled into an x86 container, and this argument sets that container's base

The docs say the argument must be included and that the aarch64 binaries are bundled into an x86 container. It doesn't change the DPU, enable emulation or set a registry.

</details>

**3. Which variable controls the platforms of the `boot-artifacts-aarch64` image?**

A. DPU_ARCHES
B. BOOT_ARTIFACTS_ARCHES
C. NICO_ARCHES
D. It's always arm64 only

<details>
<summary>Answer</summary>

**A.** DPU_ARCHES

`DPU_ARCHES` governs `images-bfb`, and the verification loop compares `boot-artifacts-aarch64` against it. Its default is both architectures, not arm64 only.

</details>

**Sources:** [manuals/building_nico_containers.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/building_nico_containers.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="build-task"></a>
## Build task: Ship a multi-arch Rust service and an aarch64 artifact through a local registry, NICo-style

**Goal:** Compile a small Rust program for amd64 and arm64 in separate builds and push the per-arch tags to a local registry. Assemble one multi-arch tag, package the arm64 binary as a 'boot artifact' inside an amd64 container, and verify every tag's platforms with a loop modelled on NICo's.

**Why it matters for NICo:** This is `make images` and `make images-bfb` in miniature. You use a registry on localhost:5000, a pinned context and built-in builder, and QEMU for the non-native architecture. You build each architecture separately and join them into a bare tag, then package an artifact container whose platform differs from its payload. When a real NICo build prints `FAIL nico-flow: got linux/amd64, want ...`, you'll know which layer to suspect.

**You need:**

- Docker Engine with the buildx plugin on Linux, or Docker Desktop on macOS/Windows. Check with `docker buildx version`. Buildx 0.13 or newer is recommended
- `jq`, `curl` and `file` on the host
- About 3 GB free disk space and internet access to pull `rust:1-slim-bookworm`, `debian:bookworm-slim`, `alpine:3.20`, `registry:2` and `tonistiigi/binfmt`
- No local Rust toolchain needed: compilation happens inside the build container
- A free host port for the registry: 5000 normally, or 5001 on macOS (AirPlay) or on a host where NICo's `nico-build-registry` is running (`docker ps --filter name=nico-build-registry`)
- An empty working directory, e.g. `mkdir ~/nico-lab13 && cd ~/nico-lab13`

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Create the Rust crate and Dockerfile</summary>

`Cargo.toml`:
```toml
[package]
name = "hello-arch"
version = "0.1.0"
edition = "2021"

[dependencies]
```
`src/main.rs`:
```rust
fn main() {
    println!("hello-arch {} {}", std::env::consts::ARCH, std::env::consts::OS);
}
```
`Dockerfile` (build and runtime both use Debian bookworm, so glibc matches):
```dockerfile
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=build /src/target/release/hello-arch /usr/local/bin/hello-arch
ENTRYPOINT ["/usr/local/bin/hello-arch"]
```

</details>

<details>
<summary>Step 2: Start a fresh local registry and set lab variables</summary>

```sh
export REG=localhost:5000 TAG=lab1      # use localhost:5001 on macOS or if nico-build-registry holds 5000
docker rm -f lab-registry 2>/dev/null || true   # remove any registry left over from the lessons
docker run -d --restart=always -p "${REG##*:}":5000 --name lab-registry registry:2
curl -s "http://$REG/v2/_catalog"        # {"repositories":[]}
```
The `docker rm -f` ensures you start from an empty registry with no name clash. If `docker run` still reports `port is already allocated`, another container owns that port: check `docker ps --format '{{.Names}} {{.Ports}}'`, then switch `REG` to `localhost:5001` and re-run these lines.

</details>

<details>
<summary>Step 3: Enable emulation and pin the builder</summary>

```sh
docker run --privileged --rm tonistiigi/binfmt --install arm64,amd64
export DOCKER_CONTEXT="$(docker context show)"
export BUILDX_BUILDER="$DOCKER_CONTEXT"
docker buildx ls        # the selected builder uses the 'docker' driver
docker run --rm --platform linux/arm64 alpine:3.20 uname -m   # aarch64
docker run --rm --platform linux/amd64 alpine:3.20 uname -m   # x86_64
```

</details>

<details>
<summary>Step 4: Build and push each architecture separately</summary>

```sh
for arch in amd64 arm64; do
  docker build --platform "linux/$arch" -t "$REG/hello-arch:$TAG-$arch" .
  docker push "$REG/hello-arch:$TAG-$arch"
done
curl -s "http://$REG/v2/hello-arch/tags/list"
```
The non-native build compiles Rust under QEMU, so expect it to take several minutes.

</details>

<details>
<summary>Step 5: Assemble the bare multi-arch tag</summary>

```sh
docker buildx imagetools create -t "$REG/hello-arch:$TAG" \
  "$REG/hello-arch:$TAG-amd64" "$REG/hello-arch:$TAG-arm64"
docker buildx imagetools inspect "$REG/hello-arch:$TAG"
```

</details>

<details>
<summary>Step 6: Package the arm64 binary as an artifact in an amd64 container</summary>

```sh
mkdir -p artifacts
docker create --platform linux/arm64 --name x "$REG/hello-arch:$TAG-arm64"
docker cp x:/usr/local/bin/hello-arch artifacts/hello-arch-aarch64
docker rm x
file artifacts/hello-arch-aarch64       # ... ARM aarch64 ...
```
`Dockerfile.artifacts`:
```dockerfile
ARG CONTAINER_RUNTIME=alpine:latest
FROM ${CONTAINER_RUNTIME}
COPY artifacts/ /artifacts/
```
```sh
docker build --platform linux/amd64 --build-arg CONTAINER_RUNTIME=alpine:3.20 \
  -f Dockerfile.artifacts -t "$REG/lab-artifacts-aarch64:$TAG-amd64" .
docker push "$REG/lab-artifacts-aarch64:$TAG-amd64"
docker buildx imagetools create -t "$REG/lab-artifacts-aarch64:$TAG" \
  "$REG/lab-artifacts-aarch64:$TAG-amd64"
```

</details>

<details>
<summary>Step 7: Write the verification script</summary>

`verify.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
REG="${REG:-localhost:5000}"
TAG="${TAG:-lab1}"

expected_for() {
  case "$1" in
    hello-arch) echo "linux/amd64,linux/arm64" ;;
    lab-artifacts-aarch64) echo "linux/amd64" ;;
  esac
}

for image in hello-arch lab-artifacts-aarch64; do
  expected="$(expected_for "$image")"
  platforms="$(docker buildx imagetools inspect --raw "${REG}/${image}:${TAG}" | \
    jq -r '[.manifests[].platform | select(.os == "linux") | "\(.os)/\(.architecture)"] | unique | sort | join(",")')"
  if [ "$platforms" != "$expected" ]; then
    printf 'FAIL %s: got %s, want %s\n' "$image" "$platforms" "$expected" >&2
    exit 1
  fi
  printf 'PASS %s: %s\n' "$image" "$platforms"
done

docker run --rm --quiet --pull always --platform linux/amd64 "${REG}/hello-arch:${TAG}"
docker run --rm --quiet --pull always --platform linux/arm64 "${REG}/hello-arch:${TAG}"
file artifacts/hello-arch-aarch64 | grep -q 'aarch64' && echo 'PASS payload: aarch64'
```
`--quiet` suppresses the pull progress output. Run the script with `bash verify.sh` in the same shell, so `REG` and `TAG` are set.

</details>

**Check it works:** `bash verify.sh` exits 0 (`echo $?` prints `0`), and its standard output is exactly:
```
PASS hello-arch: linux/amd64,linux/arm64
PASS lab-artifacts-aarch64: linux/amd64
hello-arch x86_64 linux
hello-arch aarch64 linux
PASS payload: aarch64
```
If your Docker version ignores `--quiet` for pulls, you may also see pull progress such as `Pulling from…` or `Status: Downloaded newer image…`. That's expected and goes to stderr. Check stdout alone with `bash verify.sh 2>/dev/null`. The last three lines show that one tag served native code for each architecture, and that the amd64 artifact container carries an aarch64 payload.

<details>
<summary>If you get stuck</summary>

- `exec format error` during the arm64 build or run means QEMU isn't registered. Re-run the `tonistiigi/binfmt --install` command (on some systems the registration resets after a host reboot).
- `Conflict. The container name "/lab-registry" is already in use` means you skipped the `docker rm -f lab-registry` line in step 2. Run it, then start the registry again.
- `port is already allocated` or 'address already in use' on port 5000 is usually AirPlay Receiver on macOS or NICo's `nico-build-registry` on a build host. Set `REG=localhost:5001` and redo step 2.
- `http: server gave HTTP response to HTTPS client` means you used a hostname other than `localhost` for the registry. Docker only allows plain HTTP to localhost by default.
- If jq says `Cannot iterate over null`, the tag is a plain manifest, not an index. An older buildx can do this, copying a single source tag as-is instead of wrapping it in an index. Upgrade buildx, or pass `--prefer-index` to `imagetools create` for the single-source artifact tag.
- `version 'GLIBC_x' not found` at run time means the build and runtime stages use different Debian releases. Keep both on bookworm as shown.
- A `pull access denied` for one of your own images during a build means the build ran on a docker-container builder. Check that `BUILDX_BUILDER` is set to your context name.
- With Docker's containerd image store, `docker push` may also push attestation manifests (`unknown/unknown`). The `select(.os == "linux")` filter ignores them, which is why NICo's loop has it.
- When you're done: `unset DOCKER_CONTEXT BUILDX_BUILDER; docker rm -f lab-registry`.

</details>

**Stretch goal:** Wrap steps 4–5 in a GNU `Makefile` with an `ARCHES ?= amd64 arm64` variable. Like `NICO_ARCHES`, it should fail fast with an error if any value isn't `amd64` or `arm64`. It should build and push `$(REG)/hello-arch:$(TAG)-<arch>` for each listed architecture, then assemble the bare tag from exactly those tags. Extend `verify.sh` to compute the expected platforms from `ARCHES` (use `tr`, `sed`, `sort` and `paste` like NICo's `expected_platforms_for`). Confirm that `make ARCHES=arm64` followed by `ARCHES=arm64 bash verify.sh` passes with a single-entry index.

## Review notes

The draft was rewritten twice using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **major-issues**. Issues to fix before relying on this chapter:

- **major** (Build host bootstrap (make bootstrap)): The worked example runs make bootstrap, reboots, and then expects `ls /proc/sys/fs/binfmt_misc/ | grep qemu-aarch64` to show a registered emulator. tonistiigi/binfmt only writes registrations into the running kernel (binfmt_misc). They don't survive a reboot unless something re-registers them at boot, and nothing in the bootstrap's apt list (e.g. qemu-user-static or /etc/binfmt.d entries) appears to do that. So this verify step is likely to print nothing, and later arm64 builds would hit exec format error. The chapter half-admits this in the build-task hint ('on some systems the registration resets after a host reboot'), which contradicts this lesson's expected output. *Fix:* After the reboot, tell the learner to check for the registration and, if it's missing, re-run `sudo docker run --privileged --rm tonistiigi/binfmt --install all` (or install qemu-user-static/binfmt-support so the registration persists). Say plainly that binfmt registrations are runtime kernel state, not persistent configuration.
- **minor** (Build host bootstrap (make bootstrap)): The explanation repeats the docs' line that rebooting *or* logging out and back in applies the userns sysctl. The independent-problem answer then says a re-login alone won't guarantee the sysctl is in effect. The two statements contradict each other. Files in /etc/sysctl.d are applied at boot or by `sysctl --system`, not at login. *Fix:* Use one consistent message, e.g. 'log out/in for the group; reboot, or run `sudo sysctl --system`, for the sysctl'.
- **minor** (Multi-architecture image manifest): A prequestion answer says the amd64-binary-in-arm64-image problem 'happens with the REST Dockerfiles'. The docs only say a combined invocation 'could' copy an amd64 binary into the arm64 image. *Fix:* Change it to 'could happen with the REST Dockerfiles'.

---

[← 12-boot-network-services.md](12-boot-network-services.md) · [14-kubernetes-basics.md →](14-kubernetes-basics.md)
