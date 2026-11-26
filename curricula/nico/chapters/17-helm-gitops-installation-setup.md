# Chapter 17: Helm & GitOps · Installation & Setup

*Part: Kubernetes & Deployment · 7 concepts · [curriculum](../curriculum.md#chapter-17)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

In Chapters 14–16 you learned what a Kubernetes cluster is made of, how traffic reaches it through MetalLB VIPs, and how much CPU and memory a NICo site controller needs. This chapter covers how NICo gets installed on that cluster and kept up to date.

NICo isn't one container. It is a stack: storage provisioners, a Postgres operator, MetalLB, cert-manager, Vault (optional), External Secrets, the DPF stack, RMS, NICo Core, NICo REST, Flow and the site-agent. Each piece ships as Kubernetes manifests, and the stack only works if they go in the right order with the right settings for your site. The tools that do this are **Helm** (packages called charts, configured by values files), **helmfile** (manages many Helm releases at once), **Kustomize** (layers site-specific changes over base manifests) and, optionally, **GitOps with ArgoCD** (a controller that keeps the cluster matching what's in Git).

On top of these tools, NICo provides `helm-prereqs/setup.sh`. This script installs everything in numbered phases. Before it changes anything, it runs `preflight.sh` to check your environment. You'll also look at PostgreSQL, deployed through the Zalando operator. It holds all NICo Core state, plus the databases of other components such as NICo REST, so it's the component you most need to size correctly and protect.

The chapter ends with a build where you write a small `setup.sh` of your own on a laptop `kind` cluster. It has a preflight check, helmfile releases, a Kustomize overlay and a Postgres database with NICo's two required extensions. Running it a second time must change nothing.

**By the end of this chapter you can:**

- Install, render, diff and upgrade Helm charts with helm and helmfile, and explain how values files and --set combine
- Write a Kustomize base and overlay and predict the manifests it renders
- Explain how a GitOps controller such as ArgoCD syncs a cluster from Git, and why secrets must not be committed
- Describe NICo's PostgreSQL deployment (Zalando operator, nico_system_nico, btree_gin and pg_trgm) and which sizing signal means it needs more memory
- Plan a setup.sh run for a given site (environment variables, skip flags, -y) and upgrade a site by re-running it
- Read preflight.sh results and decide whether setup will stop, prompt or continue

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [Helm and helmfile](#helm-and-helmfile)
2. [Kustomize](#kustomize)
3. [GitOps with ArgoCD](#gitops-with-argocd)
4. [Helm chart values](#helm-chart-values)
5. [PostgreSQL (Zalando operator)](#postgresql)
6. [setup.sh orchestrator](#setup-sh-orchestrator)
7. [Preflight checks (preflight.sh)](#preflight-checks)
8. [Build task: Build a mini setup.sh: preflight, helmfile, Kustomize overlay and Postgres with NICo's extensions](#build-task)

<a id="helm-and-helmfile"></a>
## 1. Helm and helmfile

*Builds on: Kubernetes workload and config objects (ch. 14), YAML (ch. 1)*

### Before you read

- You need to install the same application on 20 clusters, each with a different hostname and replica count. Would you rather keep 20 copies of the YAML, or one template plus 20 small settings files? What could go wrong with each approach?
- If you run the same install command twice, what should happen the second time?

<details>
<summary>Answers</summary>

- **You need to install the same application on 20 clusters, each with a different hostname and replica count. Would you rather keep 20 copies of the YAML, or one template plus 20 small settings files? What could go wrong with each approach?** Most teams pick one template plus small settings files. Twenty copies drift apart, and a fix has to be made twenty times. The template approach has its own cost: you need a tool that renders the template, and you have to understand which setting wins when settings overlap. Helm is that tool.
- **If you run the same install command twice, what should happen the second time?** Ideally nothing should change on the cluster. Repeating `helm upgrade --install` with the same inputs leaves the Kubernetes objects as they are, but Helm still records a new release revision. `helmfile apply` goes one step further: it diffs first and skips releases that haven't changed, so no new revision is recorded.

</details>

### Explanation

**Helm** is the package manager for Kubernetes. Its package is a **chart**, a directory containing:

- `Chart.yaml`: the chart's name and version.
- `values.yaml`: the default settings.
- `templates/`: Kubernetes manifests (Deployments, Services, and so on) with Go-template placeholders such as `{{ .Values.replicaCount }}`.

When you install a chart, Helm merges your **values** (YAML settings) into the templates, renders plain manifests and applies them. The installed instance is called a **release**. It has a name, a namespace and a revision number that increases with each upgrade, which makes `helm rollback` possible.

Commands you'll use all the time:

| Command | What it does |
|---|---|
| `helm template NAME CHART -f vals.yaml` | Render to stdout without touching a cluster |
| `helm upgrade --install NAME CHART -n NS` | Install if missing, upgrade if present. Safe to repeat, though every run adds a revision |
| `helm list -n NS` / `helm history NAME -n NS` | See releases and revisions |
| `helm diff upgrade ...` | Show what would change (needs the **helm-diff** plugin) |

A real site runs many releases: MetalLB, cert-manager, the Postgres operator, Vault and more. Running `helm` by hand for each one is error-prone. **helmfile** fixes this by letting you list all releases in one declarative `helmfile.yaml`, including their chart, namespace and values files:

- `helmfile diff` uses helm-diff to show pending changes.
- `helmfile apply` diffs first, then upgrades only the releases that changed.
- `helmfile sync` upgrades every release regardless.

**In NICo:** the machine where you run `setup.sh` needs `helm` 3.12 or later, `helmfile` 0.162 or later and the `helm-diff` plugin. The docs state plainly that helmfile requires helm-diff. `setup.sh` installs prerequisites such as MetalLB 0.14.5, cert-manager, postgres-operator 1.11.0, Vault and external-secrets as Helm charts. NICo Core and REST are Helm charts too (`../helm`, `../helm/rest/nico-rest`). The teardown script `clean.sh` removes "all helmfile releases". The Reference Installation describes `setup.sh` as "a thin wrapper over the Helm charts and kustomize manifests".

**Analogy.** Helm is like a mail-merge. The chart is the letter template, the values file is the spreadsheet row and the release is the printed letter you sent. helmfile is the mailing list that says which letters go to whom. The analogy breaks down after printing: a letter, once sent, stays the same. A Helm release keeps a revision history you can diff, upgrade and roll back.

### Worked example: From chart to helmfile on a laptop

**Step 1: Check the toolchain.**

```bash
helm version          # v3.12+ (or v4)
helmfile --version    # 0.162+
helm plugin list      # should show 'diff'
# if missing (Helm v3):
helm plugin install https://github.com/databus23/helm-diff
# Helm v4: add --verify=false
```

**Step 2: Create a chart and look inside.**

```bash
helm create demo
ls demo            # Chart.yaml  charts/  templates/  values.yaml
grep -n replicaCount demo/values.yaml demo/templates/deployment.yaml
```
You'll see `replicaCount: 1` in values.yaml and `replicas: {{ .Values.replicaCount }}` in the template.

**Step 3: Render without a cluster.**

```bash
helm template web ./demo --set replicaCount=2 | grep -n 'replicas:'
```
The output shows `replicas: 2`. Rendering is safe and fast, and it's the first thing to try when a chart misbehaves.

**Step 4: Install, then repeat the same command.**

```bash
kind create cluster --name helm-lab
helm upgrade --install web ./demo -n demo --create-namespace
helm upgrade --install web ./demo -n demo   # same command again
helm history web -n demo                    # REVISION 1 and 2
```
The Deployment didn't change, but Helm still recorded revision 2. Next you'll see how helmfile avoids that.

**Step 5: Move to helmfile and diff.**

Create `values/demo.yaml` containing `replicaCount: 2`, then `helmfile.yaml`:
```yaml
releases:
  - name: web
    namespace: demo
    chart: ./demo
    values:
      - values/demo.yaml
```
```bash
helmfile diff    # shows replicas 1 -> 2
helmfile apply   # upgrades web (revision 3)
helmfile apply   # no changes, so no new revision
```

### Your turn: finish it

Your directory has a chart at `./charts/demo` and a values file at `values/demo.yaml`. Fill in the blanks so that `helmfile apply` installs a release called `web` into namespace `demo`.

```text
releases:
  - name: web
    namespace: demo
    chart: ___
    values:
      - ___
```

<details>
<summary>Answer</summary>

releases:
  - name: web
    namespace: demo
    chart: ./charts/demo
    values:
      - values/demo.yaml

</details>

### Your turn: on your own

A teammate changes `replicaCount` from 2 to 3 in `values/demo.yaml` and opens a pull request. Before merging, you want to see exactly which Kubernetes fields will change on the cluster, without changing anything. Which command do you run, what does it need installed, and what happens if you then run `helmfile apply` twice?

<details>
<summary>Hint 1</summary>

One helmfile subcommand only shows changes.

</details>

<details>
<summary>Hint 2</summary>

That subcommand depends on a Helm plugin, the same one NICo's quick start tells you to install.

</details>

<details>
<summary>Hint 3</summary>

`apply` runs a diff first and upgrades only releases that differ.

</details>

<details>
<summary>Answer</summary>

Run `helmfile diff`. It needs the helm-diff plugin and shows `replicas: 2 -> 3` on the Deployment. The first `helmfile apply` upgrades the `web` release (new revision). The second finds no difference and leaves it alone, so no new revision is recorded.

</details>

### Explain it

In your own words: Why does a multi-component install like NICo's use helmfile and a diff step instead of a shell script that calls `helm install` for each chart?

### Check

**1. Which command renders a chart's manifests locally without contacting a cluster?**

A. helm template
B. helm install --dry-run=server
C. helm list
D. helmfile sync

<details>
<summary>Answer</summary>

**A.** helm template

`helm template` renders entirely client-side. `--dry-run=server` contacts the API server to validate. `helm list` shows existing releases. `helmfile sync` actually applies changes.

</details>

**2. NICo's quick start lists the helm-diff plugin as a required tool. Why?**

A. helmfile needs it to compute the diff behind `helmfile diff` and `helmfile apply`
B. Helm cannot install charts without it
C. It encrypts values files
D. It is used to roll back failed releases

<details>
<summary>Answer</summary>

**A.** helmfile needs it to compute the diff behind `helmfile diff` and `helmfile apply`

The docs state that helmfile requires helm-diff. Helm installs charts and rolls back without the plugin, and helm-diff does no encryption.

</details>

**3. What is a Helm release?**

A. A named, versioned installation of a chart in a namespace
B. The chart's version number in Chart.yaml
C. A tarball pushed to a registry
D. A values file

<details>
<summary>Answer</summary>

**A.** A named, versioned installation of a chart in a namespace

The chart is the package and the release is an installed instance of it, with a revision history. Chart.yaml's version describes the package, not the installation.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md)

<a id="kustomize"></a>
## 2. Kustomize

*Builds on: Kubernetes workload and config objects (ch. 14)*

### Before you read

- You have a working Deployment YAML from upstream and need to add a label and a memory limit for your site, without editing the upstream file. How could you describe only the difference?

<details>
<summary>Answers</summary>

- **You have a working Deployment YAML from upstream and need to add a label and a memory limit for your site, without editing the upstream file. How could you describe only the difference?** Keep the upstream file as a base and write a small patch containing only the fields you want to change. A tool then merges the patch on top. That is how Kustomize works.

</details>

### Explanation

**Kustomize** customises Kubernetes YAML without templates. It's built into `kubectl`: `kubectl kustomize DIR` renders, and `kubectl apply -k DIR` renders and applies.

It uses two ideas:

- **Base**: a directory of ordinary manifests plus a `kustomization.yaml` that lists them under `resources:`.
- **Overlay**: another directory whose `kustomization.yaml` points at the base (`resources: - ../../base`) and adds changes on top.

Common overlay fields:

| Field | Effect |
|---|---|
| `namespace:` | Sets the namespace on every resource |
| `labels:` | Adds labels |
| `namePrefix:` | Prefixes every resource name |
| `replicas:` | Overrides a Deployment's replica count by name |
| `patches:` | Merges partial YAML onto matching resources (a strategic merge patch: write only the fields you change, and named list items such as containers are matched by `name`) |

Helm and Kustomize differ in one way. Helm exposes only the knobs the chart author put in `values.yaml`. Kustomize can change any field of any manifest, but it has no release history and no rollback.

**In NICo:**

- `setup.sh --site-overlay <dir>` applies a site Kustomize overlay after Phase 6 (NICo Core).
- `--metallb-config <path>` accepts either a plain MetalLB manifest file or a Kustomize directory.
- The NICo REST stack under `rest-api/` ships Kustomize bases that `setup.sh` uses for Phase 7.

Site-specific changes can therefore live in your own overlay directory instead of inside the repository's files, which keeps upgrades clean.

**Analogy.** A base is a printed form and an overlay is a transparent sheet laid on top with a few fields filled in differently. Swap the sheet for another site and the form underneath is unchanged. The analogy breaks down because a Kustomize patch only works if it addresses the right resource by kind and name. A typo in the name silently fails to match, or causes an error. A transparent sheet always lines up.

### Worked example: Base plus site overlay, rendered locally

**Step 1: Write the base.**

```bash
mkdir -p kz/base kz/overlays/site && cd kz
cat > base/deployment.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27
EOF
cat > base/kustomization.yaml <<'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
EOF
```

**Step 2: Write a patch with only the changed fields.**

```bash
cat > overlays/site/limits.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  template:
    spec:
      containers:
        - name: web
          resources:
            limits:
              memory: 256Mi
EOF
```
The container is matched by `name: web`, so its `image` is kept.

**Step 3: Write the overlay kustomization.**

```bash
cat > overlays/site/kustomization.yaml <<'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: site-a
resources:
  - ../../base
replicas:
  - name: web
    count: 3
patches:
  - path: limits.yaml
EOF
```

**Step 4: Render and inspect.**

```bash
kubectl kustomize overlays/site
```
In the output, check for `namespace: site-a`, `replicas: 3`, `image: nginx:1.27` (from the base) and `memory: 256Mi` (from the patch). To apply it to a cluster: `kubectl apply -k overlays/site`.

### Your turn: finish it

Fill in the blanks so the overlay builds on `../../base` and applies the patch file `limits.yaml`.

```text
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: site-a
resources:
  - ___
patches:
  - path: ___
```

<details>
<summary>Answer</summary>

apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: site-a
resources:
  - ../../base
patches:
  - path: limits.yaml

</details>

### Your turn: on your own

Add a second overlay, `overlays/lab`, that reuses the same base but deploys into namespace `lab` with 1 replica and no memory limit. Render it and confirm. Then explain why a NICo operator would keep site changes in a directory passed to `setup.sh --site-overlay` instead of editing files in the checked-out repo.

<details>
<summary>Hint 1</summary>

The overlay needs only a kustomization.yaml. Leave out patches you don't want.

</details>

<details>
<summary>Hint 2</summary>

`resources: - ../../base`, `namespace: lab`, and either omit `replicas:` (the base already has 1) or set `count: 1`.

</details>

<details>
<summary>Hint 3</summary>

Think about what happens to your local edits when you `git checkout` the next release tag to upgrade.

</details>

<details>
<summary>Answer</summary>

`overlays/lab/kustomization.yaml`:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: lab
resources:
  - ../../base
```
`kubectl kustomize overlays/lab` shows namespace `lab`, `replicas: 1` and no `resources:` block. Keeping site changes in a separate overlay means upgrading is just checking out the new release and re-running `setup.sh` with the same `--site-overlay`. Your changes aren't mixed into upstream files, where they would conflict or get lost.

</details>

### Explain it

In your own words: Why might a project use Helm for its own components but accept a Kustomize overlay for site-specific tweaks, instead of exposing every possible field as a Helm value?

### Check

**1. In a strategic merge patch on a Deployment, how does Kustomize know which container to modify?**

A. It matches list items by the container's `name`
B. It patches the first container in the list
C. It replaces the whole containers list
D. It matches by image

<details>
<summary>Answer</summary>

**A.** It matches list items by the container's `name`

For containers, strategic merge uses `name` as the merge key. That's why the image from the base survives. Replacing the whole list is what a plain JSON merge or a Helm values list override does.

</details>

**2. Which setup.sh option applies a site Kustomize overlay, and when?**

A. --site-overlay <dir>, after Phase 6
B. --metallb-config <dir>, before Phase 0
C. --core-values <file>, during Phase 7
D. --site-overlay <dir>, before preflight

<details>
<summary>Answer</summary>

**A.** --site-overlay <dir>, after Phase 6

The quick start says `--site-overlay` applies a site kustomize overlay after Phase 6. `--metallb-config` also accepts a kustomize directory, but only for the MetalLB config. `--core-values` takes a Helm values file.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md)

<a id="gitops-with-argocd"></a>
## 3. GitOps with ArgoCD

*Builds on: Helm and helmfile (ch. 17), Kubernetes Secret (ch. 14), Git version control (ch. 2)*

### Before you read

- Someone fixes a production problem by running `kubectl edit` on a Deployment. A month later the cluster is rebuilt from the repo. What happens to their fix?
- Is it safe to commit a database password to the Git repo that a GitOps controller deploys from?

<details>
<summary>Answers</summary>

- **Someone fixes a production problem by running `kubectl edit` on a Deployment. A month later the cluster is rebuilt from the repo. What happens to their fix?** It's lost, because it only existed in the live cluster. GitOps addresses this by making Git the source of truth and having a controller continuously reconcile the cluster to match it.
- **Is it safe to commit a database password to the Git repo that a GitOps controller deploys from?** No. Anyone with read access to the repo, or its history, gets the password. Commit a reference to the secret instead, and let a tool such as External Secrets Operator create the real Kubernetes Secret inside the cluster.

</details>

### Explanation

**GitOps** is a way of doing continuous delivery. The desired state of the cluster (manifests, Helm charts, values) lives in a Git repository, and a controller running *inside* the cluster keeps the live state matching it. You change the cluster by merging a commit, not by running `kubectl` or `helm` from a laptop. Git then gives you review, audit history and rollback (`git revert`) for free.

**ArgoCD** is a popular GitOps controller. You describe what to deploy with an `Application` custom resource:

- **source**: a Git repo URL, a revision (branch or tag) and a path. The path can hold plain YAML, a Kustomize directory or a Helm chart, and for Helm you can list `valueFiles`.
- **destination**: which cluster and namespace to deploy into.
- **syncPolicy**: whether to sync automatically. `prune` deletes objects that were removed from Git. `selfHeal` reverts manual changes made in the cluster, which are called **drift**.

ArgoCD repeatedly renders the source, compares it with the live objects and reports each Application as *Synced* or *OutOfSync* and as *Healthy* or *Degraded*.

**Secrets** are the hard part. Git is the wrong place for plaintext credentials. The usual pattern is to commit objects that *refer to* secrets and let an operator create the actual Kubernetes Secret in the cluster. NICo already does this: External Secrets Operator (ESO) copies the `site-root` CA bundle and the database credentials into NICo namespaces as Kubernetes Secrets.

**In NICo:** the docs list ArgoCD as an *optional* prerequisite for "GitOps-based continuous delivery for deploying and updating NICo components". The supported automated path is `setup.sh`. Separately, `setup.sh` installs `argo-cd` as part of the DPF stack for DPU provisioning (skipped with `--skip-dpf`). The docs don't describe a NICo-specific ArgoCD repo layout, so treat the example below as generic ArgoCD.

**Analogy.** GitOps is like a thermostat. Git holds the set temperature and the controller keeps adjusting the room to match. If someone opens a window (a manual `kubectl edit`), self-heal closes it again. The analogy breaks down in one place: a thermostat never deletes furniture, but ArgoCD with `prune` will delete objects that disappear from Git. A bad commit can therefore remove real resources.

### Worked example: Reading an ArgoCD Application and tracing one change

**Step 1: Read the Application.**

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: demo-web
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://git.example.com/infra/site-a.git
    targetRevision: main
    path: charts/demo
    helm:
      valueFiles:
        - values-site-a.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: demo
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```
This renders the Helm chart at `charts/demo` with `values-site-a.yaml` and deploys it into the same cluster ArgoCD runs in.

**Step 2: Make a change the GitOps way.**

Edit `values-site-a.yaml` (for example `replicaCount: 3`), open a pull request, get review and merge to `main`. Nobody runs `helm upgrade`.

**Step 3: Watch the controller reconcile.**

ArgoCD notices that `main` moved, renders the chart, finds the Deployment differs (OutOfSync) and, because `automated` is set, syncs it. The Application returns to Synced/Healthy.

**Step 4: Observe drift being reverted.**

Someone runs `kubectl scale deploy/demo-web -n demo --replicas=1`. With `selfHeal: true`, ArgoCD reapplies 3. Without self-heal, it reports OutOfSync and waits for a manual sync.

**Step 5: Handle the secret.**

The chart needs a DB password. Instead of committing it, the repo holds an ExternalSecret (or similar) that the in-cluster operator turns into a real Secret. ESO plays this role for NICo's database credentials and root CA bundle.

### Your turn: finish it

Complete the Application so it deploys the Kustomize overlay at `overlays/site-a` and automatically reverts manual changes made in the cluster.

```text
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: site-a
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://git.example.com/infra/site-a.git
    targetRevision: main
    path: ___
  destination:
    server: https://kubernetes.default.svc
    namespace: site-a
  syncPolicy:
    automated:
      prune: true
      ___: true
```

<details>
<summary>Answer</summary>

apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: site-a
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://git.example.com/infra/site-a.git
    targetRevision: main
    path: overlays/site-a
  destination:
    server: https://kubernetes.default.svc
    namespace: site-a
  syncPolicy:
    automated:
      prune: true
      selfHeal: true

</details>

### Your turn: on your own

Your team adopts ArgoCD for an application stack. List three things that change for operators compared with running `helm upgrade` from a laptop. For each, say whether it is a benefit or a new risk. Include one point about secrets.

<details>
<summary>Hint 1</summary>

Think about who can change the cluster, and how.

</details>

<details>
<summary>Hint 2</summary>

Think about what `prune` and `selfHeal` do when Git is wrong, or when someone hot-fixes the cluster.

</details>

<details>
<summary>Hint 3</summary>

Where does the database password come from if it can't live in Git?

</details>

<details>
<summary>Answer</summary>

Possible answers:
1. Changes go through Git review and history (benefit: audit trail and `git revert` rollback).
2. Manual hot-fixes are reverted by self-heal (benefit: no silent drift; risk: an emergency `kubectl edit` disappears unless it's also committed).
3. With `prune`, deleting a file from Git deletes the live object (risk: a bad commit can remove resources).
4. Secrets can't be committed as plaintext. The repo holds references, and an in-cluster operator such as ESO creates the Kubernetes Secrets (new design work, but it keeps credentials out of Git history).

</details>

### Explain it

In your own words: Why does GitOps put the controller inside the cluster pulling from Git, instead of having a CI job push changes into the cluster?

### Check

**1. In NICo's documentation, what is ArgoCD's status as a prerequisite for deploying NICo?**

A. Optional; GitOps-based delivery for deploying and updating NICo components
B. Required; setup.sh refuses to run without it
C. Required only for NICo REST
D. Replaced by Temporal

<details>
<summary>Answer</summary>

**A.** Optional; GitOps-based delivery for deploying and updating NICo components

The prerequisite list marks ArgoCD as optional. setup.sh is the supported automated path. Temporal is a workflow engine, not a delivery tool. (argo-cd does appear inside the DPF stack, but that doesn't make it a requirement for deploying NICo.)

</details>

**2. An Application has `selfHeal: true`. An operator runs `kubectl scale` to change the replica count. What happens?**

A. ArgoCD reapplies the replica count from Git
B. ArgoCD commits the new replica count back to Git
C. Nothing; selfHeal only applies to deleted objects
D. The Application is deleted

<details>
<summary>Answer</summary>

**A.** ArgoCD reapplies the replica count from Git

Self-heal reverts live drift to the Git state. ArgoCD doesn't write back to Git. Deleting objects removed from Git is what `prune` does, a separate setting.

</details>

**3. How does NICo get database credentials into its namespaces without putting them in a values file?**

A. External Secrets Operator copies them into Kubernetes Secrets in each namespace
B. They are hard-coded in the nico-api image
C. Temporal passes them as workflow inputs
D. ArgoCD decrypts them from Git

<details>
<summary>Answer</summary>

**A.** External Secrets Operator copies them into Kubernetes Secrets in each namespace

The software prerequisites page says ESO copies the database credentials and the site-root CA bundle into NICo namespaces through ClusterSecretStores. The other options aren't described anywhere, and they would be insecure.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="helm-chart-values"></a>
## 4. Helm chart values

*Builds on: Helm and helmfile (ch. 17)*

### Before you read

- The chart default is `replicaCount: 1`. File A sets 2, file B sets 3, and you pass `-f A -f B --set replicaCount=4`. Which value wins?
- Your override file sets a list called `extraEnv` with one entry. The base values file already had two entries. How many entries end up in the deployment?

<details>
<summary>Answers</summary>

- **The chart default is `replicaCount: 1`. File A sets 2, file B sets 3, and you pass `-f A -f B --set replicaCount=4`. Which value wins?** 4. `--set` beats files, and among files the later one (B) beats the earlier one (A). Without `--set`, the result would be 3.
- **Your override file sets a list called `extraEnv` with one entry. The base values file already had two entries. How many entries end up in the deployment?** One. Helm deep-merges maps, but a list is replaced as a whole. You must repeat any base entries you want to keep.

</details>

### Explanation

Every Helm chart has defaults in its own `values.yaml`. You override them with your own **values files** (`-f file.yaml`, or the `values:` list in helmfile) and, for one-off tweaks, `--set key=value`. Helm merges them in a fixed order, and later sources win:

1. Chart defaults (`values.yaml` inside the chart)
2. `-f` files, in the order given
3. `--set` / `--set-string`

Two merge rules cause most surprises:

- **Maps merge key by key.** Setting `podAnnotations.size` in one file and `podAnnotations.team` in another gives you both.
- **Lists are replaced whole.** A list in a later file throws away the earlier list completely.

Two more things to know:

- **Umbrella charts.** A chart can bundle subcharts. Values for a subchart sit under the subchart's name, which is why NICo's `values/nico-core.yaml` has top-level keys such as `nico-api:`, `nico-dhcp:` and `nico-dns:`.
- **Types matter.** Kubernetes annotations must be strings. The quick start warns that an unquoted `true` or number in an annotation is rejected at apply time. Write `"true"`.

Useful commands: `helm show values CHART` (see the defaults), `helm get values RELEASE` (see what you supplied) and `helm template ... -f a -f b` (preview the merge).

**In NICo:**

- `helm-prereqs/values.yaml` sets `siteName` and the `postgresql` block (instances, volumeSize, resources). It also contains the Postgres memory sizing table: 16 GiB up to 5,000 hosts and 32 GiB beyond that.
- `values/nico-core.yaml` holds Core settings, `values/nico-rest.yaml` holds REST settings and `values/metallb-config.yaml` holds the MetalLB config.
- For large fleets NICo ships `helm-prereqs/values/nico-core-10k-hosts.yaml` and `nico-core-20k-hosts.yaml`.
- `setup.sh --core-values <file>` points Phase 6 at site-specific Core values.
- The scale runs set `TOKIO_WORKER_THREADS` through the nico-api chart's `extraEnv` so the thread count matches the CPU limit.

**Analogy.** Layered values are like CSS. Defaults come first, your stylesheets override them in order and an inline style (`--set`) beats everything. The analogy breaks down on lists: in CSS you can add one more rule to a set, but a Helm list in a later file wipes out the earlier list instead of appending.

### Worked example: Watching the merge rules in rendered output

**Step 1: Start from the demo chart.**

```bash
helm create demo   # skip if you have it
helm show values ./demo | grep -nE 'replicaCount|podAnnotations|tolerations'
```

**Step 2: Write a site file and a sizing file.**

```bash
cat > values-site.yaml <<'EOF'
replicaCount: 2
podAnnotations:
  team: "infra"
tolerations:
  - key: "dedicated"
    operator: "Equal"
    value: "control-plane"
    effect: "NoSchedule"
EOF
cat > values-large.yaml <<'EOF'
replicaCount: 3
podAnnotations:
  size: "large"
tolerations:
  - key: "big-node"
    operator: "Exists"
    effect: "NoSchedule"
EOF
```

**Step 3: Render with both files and a --set.**

```bash
helm template web ./demo -f values-site.yaml -f values-large.yaml \
  --set replicaCount=4 | sed -n '/kind: Deployment/,$p'
```

**Step 4: Read the result against the rules.**

- `replicas: 4`: `--set` beat both files.
- Annotations contain both `team: infra` and `size: large`, because maps merge.
- Tolerations contain **only** `big-node`, because the later list replaced the earlier one.

**Step 5: Apply the rule to NICo.**

The Day 0 guide adds a `nico-api.extraEnv` entry for `NICO_SECRETS_KEK`. If a later sizing file sets `nico-api.extraEnv` to only `TOKIO_WORKER_THREADS`, the KEK variable disappears, because that list is replaced too. Keep every entry in the final list.

### Your turn: finish it

Following the scale guidance, you're giving nico-api 32 CPUs and want 32 Tokio worker threads to match. Fill in the override so the variable is set through the nico-api chart's `extraEnv`. The value must be a string.

```text
nico-api:
  extraEnv:
    - name: ___
      value: ___
```

<details>
<summary>Answer</summary>

nico-api:
  extraEnv:
    - name: TOKIO_WORKER_THREADS
      value: "32"

</details>

### Your turn: on your own

Your site's `values/nico-core.yaml` already has this (from the Day 0 credential-store setup):
```yaml
nico-api:
  extraEnv:
    - name: NICO_SECRETS_KEK
      valueFrom:
        secretKeyRef:
          name: nico-secrets-kek
          key: site-kek-1
```
You put the `TOKIO_WORKER_THREADS` override from the previous problem in a separate file that is layered *after* it. What goes wrong at runtime, and how do you write the override file correctly?

<details>
<summary>Hint 1</summary>

What type is `extraEnv`: a map or a list?

</details>

<details>
<summary>Hint 2</summary>

Lists in later values files replace earlier lists entirely.

</details>

<details>
<summary>Hint 3</summary>

The final file must contain both entries.

</details>

<details>
<summary>Answer</summary>

`extraEnv` is a list, so the later file replaces it. nico-api starts without `NICO_SECRETS_KEK`. Its `[secrets]` config locates the key with `env = "NICO_SECRETS_KEK"`, so the Integrated KEK can't be loaded and nico-api fails to boot. The correct override repeats both entries:
```yaml
nico-api:
  extraEnv:
    - name: NICO_SECRETS_KEK
      valueFrom:
        secretKeyRef:
          name: nico-secrets-kek
          key: site-kek-1
    - name: TOKIO_WORKER_THREADS
      value: "32"
```
Run `helm template` (or `helmfile diff`) to confirm before applying.

</details>

### Explain it

In your own words: Why do you think Helm replaces lists instead of merging them? What would go wrong if it appended list items automatically?

### Check

**1. Order of precedence, lowest to highest, for Helm values:**

A. chart values.yaml < -f files in order < --set
B. --set < -f files < chart values.yaml
C. -f files < chart values.yaml < --set
D. All sources are merged and conflicts are errors

<details>
<summary>Answer</summary>

**A.** chart values.yaml < -f files in order < --set

Chart defaults are the base, files override them in the order given and --set wins. Helm doesn't raise an error on conflicts; the later source silently wins.

</details>

**2. Why do NICo's Core values have top-level keys like `nico-api:` and `nico-dhcp:`?**

A. They are subcharts of an umbrella chart, and subchart values are keyed by subchart name
B. They are Kubernetes namespaces
C. They are helmfile release names
D. They are required by Kustomize

<details>
<summary>Answer</summary>

**A.** They are subcharts of an umbrella chart, and subchart values are keyed by subchart name

An umbrella chart passes the block under each subchart's name to that subchart. They aren't namespaces (Core services run in nico-system), and they have nothing to do with Kustomize.

</details>

**3. An annotation value in your values file is written as `force-ssl-redirect: true` (unquoted). What happens, per the quick start?**

A. Apply fails, because annotations must be strings
B. Helm converts it to a string automatically
C. The annotation is silently dropped
D. It works only with Contour

<details>
<summary>Answer</summary>

**A.** Apply fails, because annotations must be strings

Annotations are map[string]string. The docs show the error `cannot unmarshal bool into Go struct field ObjectMeta.metadata.annotations of type string`. Quote the value.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [getting-started/installation-options/day0-credential-store.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-credential-store.md)

<a id="postgresql"></a>
## 5. PostgreSQL (Zalando operator)

*Builds on: Kubernetes Custom Resource (CR/CRD) (ch. 14), Persistent storage (StorageClass, PVC, local-path-provisioner) (ch. 14), Relational databases and SQL (ch. 1)*

### Before you read

- Several NICo Core services need hardware inventory. Should they all connect to the Core database directly, or go through one service? What does your choice cost or gain?
- What extra job does a Kubernetes 'operator' do for a database, beyond what a plain StatefulSet does?

<details>
<summary>Answers</summary>

- **Several NICo Core services need hardware inventory. Should they all connect to the Core database directly, or go through one service? What does your choice cost or gain?** NICo routes everything through one service: only the API Service reads and writes the `nico_system_nico` database that holds NICo Core state, and other Core services such as DHCP, PXE and Hardware Health call it over mTLS/gRPC. That keeps schema, state machines and locking in one place, at the cost of making nico-api and the Postgres primary the components that bottleneck at scale. Other parts of NICo, such as NICo REST, the site-agent and Flow, keep their own separate databases.
- **What extra job does a Kubernetes 'operator' do for a database, beyond what a plain StatefulSet does?** An operator watches a custom resource that describes the database you want (instances, volume size, users, databases). It then creates and manages the pods, replication, failover and credentials Secrets, applying operational knowledge that a StatefulSet doesn't have.

</details>

### Explanation

**PostgreSQL** holds *all* NICo Core system state: machines, network segments, resource pools, state machine progress and, on sites configured for it, encrypted credentials. That state lives in the `nico_system_nico` database, and **only the API Service (nico-api) reads and writes it**. Other Core services ask nico-api over mTLS/gRPC instead.

That rule is about the Core database, not Postgres as a whole. Other components keep their own databases:

- NICo REST and the site-agent use the `nico_rest` database on the same `nico-pg-cluster` (the site-agent's defaults set `DB_DATABASE: nico_rest`).
- RMS uses an `rms` database on `nico-pg-cluster`, and Keycloak and Temporal use it too by default.
- Flow persists its tasks, schedules and operation runs in its own PostgreSQL database.

The reference deployment uses the **Zalando Postgres Operator** (v1.11.0) with the **Spilo-15** image (Postgres 15). An operator is a controller that watches a custom resource and does the operational work for you. Here the custom resource is `kind: postgresql` (API group `acid.zalan.do`), and you list in it the number of instances, the volume size, the users and the databases. The operator then:

- creates a StatefulSet of Spilo pods, which bundle Postgres with Patroni for leader election and failover,
- creates a Service for the primary,
- generates a credentials Secret for each user.

NICo's cluster is `nico-pg-cluster` in the `postgres` namespace, exposed as a ClusterIP Service on port 5432. ESO then copies its credentials into NICo namespaces under names such as `nico-system.nico.nico-pg-cluster.credentials`.

**Required extensions:** `btree_gin` and `pg_trgm`. They ship with standard Postgres (contrib), and you enable them per database with `CREATE EXTENSION IF NOT EXISTS ...`.

- `pg_trgm` adds trigram matching, for fast `LIKE` and fuzzy text search with GIN indexes.
- `btree_gin` lets plain scalar columns such as integers join text columns in a single GIN index.

**Sizing:**

- `helm-prereqs/values.yaml` has `postgresql.instances` (3 for HA), `volumeSize` (10Gi by default) and resources.
- The scale guide says the Postgres primary's CPU limit is hit before node CPU. At the 8-CPU default this happens near 2,500 hosts.
- For memory, the sizing table gives 16 GiB up to 5,000 hosts and 32 GiB beyond. A kubelet working set sitting *at* the limit is normal, because page cache fills it. The signal to raise memory is a rising `oom_kill` count in the Postgres cgroup.

**Analogy.** The operator is like a property manager. You sign a lease saying "3-bedroom, 10 Gi storage" (the CR), and they handle plumbers, keys and replacing a broken boiler (pods, Secrets, failover). The analogy breaks down because the property manager doesn't fully own your data: backups and the right memory limit are still your decisions.

### Worked example: See why NICo needs btree_gin and pg_trgm (Docker)

**Step 1: Start Postgres 15.**

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=nico_system_nico postgres:15
sleep 5
docker exec -it pg psql -U postgres -d nico_system_nico
```

**Step 2: Create a table and try a mixed GIN index without the extensions.**

```sql
CREATE TABLE hosts (id serial PRIMARY KEY, name text, rack int);
INSERT INTO hosts(name, rack)
  SELECT 'rack' || (g % 50) || '-node' || g, g % 50 FROM generate_series(1, 5000) g;
CREATE INDEX ON hosts USING gin (rack, name);
```
This fails: neither `integer` nor `text` has a default operator class for GIN in core Postgres.

**Step 3: Enable the extensions, idempotently.**

```sql
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- running it again is a no-op (NOTICE)
\dx
```
These are the same statements NICo's prerequisites page tells you to run on an existing Postgres.

**Step 4: Build the index and query.**

```sql
CREATE INDEX hosts_rack_name ON hosts USING gin (rack, name gin_trgm_ops);
SELECT name, similarity(name, 'rack7-node1007') AS s
  FROM hosts WHERE rack = 7 AND name % 'rack7-node1007'
  ORDER BY s DESC LIMIT 3;
```
`btree_gin` makes `rack` indexable by GIN. `pg_trgm` provides `gin_trgm_ops`, `%` and `similarity()`.

**Step 5: Connect it to the operator.**

On a NICo site you don't `docker run` Postgres. The Zalando operator runs it from a `postgresql` custom resource, `setup.sh` Phase 1b installs the operator and Phase 5 creates `nico-pg-cluster`. Clean up with `docker rm -f pg`.

### Your turn: finish it

Here is a generic Zalando `postgresql` resource (not NICo's exact rendering) for a highly available Postgres 15 cluster. Fill in the instance count that gives HA in the reference deployment, and the major version that matches Spilo-15.

```text
apiVersion: acid.zalan.do/v1
kind: postgresql
metadata:
  name: demo-pg-cluster
  namespace: postgres
spec:
  teamId: demo
  numberOfInstances: ___
  volume:
    size: 10Gi
  users:
    app: []
  databases:
    appdb: app
  postgresql:
    version: "___"
```

<details>
<summary>Answer</summary>

apiVersion: acid.zalan.do/v1
kind: postgresql
metadata:
  name: demo-pg-cluster
  namespace: postgres
spec:
  teamId: demo
  numberOfInstances: 3
  volume:
    size: 10Gi
  users:
    app: []
  databases:
    appdb: app
  postgresql:
    version: "15"

</details>

### Your turn: on your own

A 3,000-host site's Grafana shows the Postgres primary's working set flat at its 16 GiB limit for a week. The cgroup `oom_kill` counter is 0 and the same pod has stayed primary all week. A colleague wants to double memory right away. Using NICo's sizing guidance, what do you recommend, and what would change your mind?

<details>
<summary>Hint 1</summary>

What makes up the kubelet working set, and does it naturally grow toward the limit?

</details>

<details>
<summary>Hint 2</summary>

What does the helm-prereqs/values.yaml table say for sites up to 5,000 hosts?

</details>

<details>
<summary>Hint 3</summary>

Which counter does the guide name as the real signal?

</details>

<details>
<summary>Answer</summary>

Don't raise it yet. The working set includes active page cache and grows toward the limit by design, so being at 16 GiB isn't evidence that more is needed. The sizing table gives 16 GiB up to 5,000 hosts, and 3,000 is within that. Raise memory (32 GiB is the next step in the table) if the `oom_kill` counter starts rising, if the primary keeps getting restarted, or if the site grows past 5,000 hosts. CPU is a separate concern: the 8-CPU default is reached near 2,500 hosts, so check the primary's CPU at this site too.

</details>

### Explain it

In your own words: Why is it a reasonable design for only nico-api to read and write the `nico_system_nico` database, even though it makes nico-api and the Postgres primary the scaling bottleneck? And why might components such as NICo REST or Flow get their own databases instead of sharing that one?

### Check

**1. Which NICo component reads from and writes to the `nico_system_nico` database (NICo Core state)?**

A. Only the API Service (nico-api)
B. Every Site Controller service
C. nico-api and the DPU Agent
D. The Site Agent, through Temporal

<details>
<summary>Answer</summary>

**A.** Only the API Service (nico-api)

The docs state that the API Service is the only service that reads from and writes to the Core database. The DPU Agent polls nico-api over gRPC. The Site Agent does connect to Postgres, but to the separate `nico_rest` database on nico-pg-cluster, not to `nico_system_nico`.

</details>

**2. Which two Postgres extensions does NICo require?**

A. btree_gin and pg_trgm
B. pgcrypto and uuid-ossp
C. postgis and hstore
D. pg_stat_statements and citext

<details>
<summary>Answer</summary>

**A.** btree_gin and pg_trgm

The software prerequisites list exactly btree_gin and pg_trgm. The others are common extensions but are not listed as requirements.

</details>

**3. Per the scale guide, what is the signal to raise the Postgres memory limit?**

A. A rising oom_kill count in the Postgres cgroup
B. The working set reaching the limit
C. Database size above 10 GB
D. More than 1,000 connections

<details>
<summary>Answer</summary>

**A.** A rising oom_kill count in the Postgres cgroup

The working set grows toward the limit by design, so reaching it isn't the signal. The guide says to treat rising oom_kill as the signal and notes that disk is not the scaling constraint.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [architecture/flow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/flow.md)

<a id="setup-sh-orchestrator"></a>
## 6. setup.sh orchestrator

*Builds on: Helm and helmfile (ch. 17), Idempotency (ch. 4)*

### Before you read

- Vault, cert-manager and Postgres all need to exist before nico-api starts. If you wrote an installer, how would you make sure a failure halfway through doesn't leave you stuck?
- How would you upgrade a system whose installer is idempotent?

<details>
<summary>Answers</summary>

- **Vault, cert-manager and Postgres all need to exist before nico-api starts. If you wrote an installer, how would you make sure a failure halfway through doesn't leave you stuck?** Install in dependency order and make each step idempotent: create-or-update, never 'create and fail if it exists'. After a failure, you fix the cause and re-run the whole thing. setup.sh works this way.
- **How would you upgrade a system whose installer is idempotent?** Check out the new version, change the image tags and run the installer again. Each step upgrades its component in place.

</details>

### Explanation

`helm-prereqs/setup.sh` is NICo's automated installer. It wraps the Helm charts, helmfile releases and Kustomize manifests and applies them in **numbered phases**, in dependency order:

| Phase | Installs |
|---|---|
| 0 | DNS check |
| 1, 1b, 1c, 1d | local-path-provisioner, Zalando postgres-operator, MetalLB plus site config, optional Contour |
| 2 | cert-manager plus site CA bootstrap |
| 3, 4 | Vault (HA Raft), then init/unseal, `nico-system` namespace, SSH host key |
| 5, 5b, 5c | external-secrets, nico-prereqs and nico-pg-cluster; DPF stack; RMS |
| 6 | **NICo Core** |
| 7a–7g, 7h, 7i | NICo REST (Keycloak, Temporal, REST services), Flow, site-agent |

**Inputs** are environment variables plus the values files from the previous lessons.

- `NICO_IMAGE_REGISTRY` is required unless you pass both `--skip-core` and `--skip-rest`. `NICO_CORE_IMAGE_TAG` and `NICO_REST_IMAGE_TAG` are each required unless their component is skipped.
- DPF is on by default and needs `NICO_DPF_DPU_INTERFACE` and `NICO_DPF_DPU_CLUSTER_VIP`, unless you pass `--skip-dpf`.
- RMS is on by default and needs `NICO_RMS_IMAGE_TAG`, unless you pass `--skip-rms`.

**Common flags:**

- `-y` accepts routine prompts and preflight warnings. Preflight *errors* still stop setup.
- `--skip-vault` (or `NICO_SKIP_VAULT=true`) installs without Vault. The choice is **not stored**, so pass it on every run.
- `--skip-core`, `--skip-rest`, `--skip-dpf` and `--skip-rms` leave out those components.
- `--core-values`, `--metallb-config` and `--site-overlay` point at site files.
- `--install-contour` adds an ingress controller.
- `--with-observability` adds the metrics, logs and traces stack.
- `--debug` turns on shell tracing, which **may print secrets**.

**Idempotent:** each phase creates or upgrades in place, so running it again is safe. **Upgrading** means checking out the target release and re-running `setup.sh` with the new image tags. Vault state, PostgreSQL data, the MetalLB config and the site UUID are preserved. `./clean.sh` tears everything down.

The idempotent pattern in shell looks like this:
```bash
kubectl create namespace demo --dry-run=client -o yaml | kubectl apply -f -
helm upgrade --install web ./demo -n demo
```
Both lines succeed whether or not the object already exists.

**Analogy.** setup.sh is like a pre-flight-to-landing checklist that a pilot can restart at the top at any time, because every item says "ensure X" instead of "do X". The analogy breaks down because some items aren't purely "ensure": some choices, such as skipping Vault, aren't remembered between runs, so you must give the same answers each time.

### Worked example: Plan an install for a lab site with no DPUs, no Vault and no RMS

**Step 1: Decide components and matching flags.**

- No DPUs (or still on iPXE): `--skip-dpf`, so no DPF variables are needed.
- Credentials in Postgres, no Vault: `--skip-vault`. This also requires the Core values contract from the helm-prereqs README.
- No rack management: `--skip-rms`, so no `NICO_RMS_IMAGE_TAG` is needed.
- Core and REST are wanted, so their image variables are required.

**Step 2: Set the environment.**

```bash
export NICO_IMAGE_REGISTRY=my-registry.example.com/nico   # no https:// scheme
export NICO_CORE_IMAGE_TAG=v2.0.0
export NICO_REST_IMAGE_TAG=v2.0.0
# export KUBECONFIG=~/.kube/lab   # only if the current context is wrong
```

**Step 3: Validate before changing anything.**

```bash
cd helm-prereqs/
source ./preflight.sh
```
Fix every error before continuing (next lesson).

**Step 4: Run interactively the first time.**

```bash
./setup.sh --skip-dpf --skip-vault --skip-rms
```
It prompts before deploying NICo Core and NICo REST. Once you trust the config, add `-y` for unattended runs.

**Step 5: Upgrade later by re-running.**

```bash
git checkout <new-release-tag>
export NICO_CORE_IMAGE_TAG=<new> NICO_REST_IMAGE_TAG=<new>
./setup.sh --skip-dpf --skip-vault --skip-rms -y
```
Use the same skip flags. Check the Upgrading NICo guide for version-specific notes first.

### Your turn: finish it

A site has DPUs (DPF on), uses the default Vault and RMS, and its cluster has no ingress controller. You want a fully unattended run. Fill in the blanks.

```text
export NICO_IMAGE_REGISTRY=my-registry.example.com/nico
export NICO_CORE_IMAGE_TAG=v2.0.0
export NICO_REST_IMAGE_TAG=v2.0.0
export NICO_RMS_IMAGE_TAG=YOUR_RMS_TAG
export NICO_DPF_DPU_INTERFACE=enp65s0f0np0
export ___=10.180.126.200
cd helm-prereqs/
./setup.sh ___ --install-contour
```

<details>
<summary>Answer</summary>

export NICO_IMAGE_REGISTRY=my-registry.example.com/nico
export NICO_CORE_IMAGE_TAG=v2.0.0
export NICO_REST_IMAGE_TAG=v2.0.0
export NICO_RMS_IMAGE_TAG=YOUR_RMS_TAG
export NICO_DPF_DPU_INTERFACE=enp65s0f0np0
export NICO_DPF_DPU_CLUSTER_VIP=10.180.126.200
cd helm-prereqs/
./setup.sh -y --install-contour

</details>

### Your turn: on your own

A site was installed last quarter with `./setup.sh --skip-vault -y`. Today a colleague upgrades it with a new shell, new tags and `./setup.sh -y`. What goes wrong, and what is the correct upgrade command? Also: they want `--debug` to diagnose a failure. What precaution applies?

<details>
<summary>Hint 1</summary>

Does setup.sh remember the Vault choice between runs?

</details>

<details>
<summary>Hint 2</summary>

What does setup.sh do about Vault by default?

</details>

<details>
<summary>Hint 3</summary>

Read what the docs say about `--debug` output.

</details>

<details>
<summary>Answer</summary>

The Vault choice is not stored, and Vault installs by default. Without `--skip-vault` (or `NICO_SKIP_VAULT=true` in the environment), the upgrade would install and configure Vault on a site designed to run without it, and deploy components with the Vault-based settings. The correct upgrade is: check out the release, export the new tags, then run `./setup.sh --skip-vault -y`. `--debug` enables shell tracing that may print secrets, so protect or securely delete those logs and don't paste them into tickets.

</details>

### Explain it

In your own words: Why does making every phase idempotent let NICo use one script for first install, recovery after a failure and upgrade?

### Check

**1. What is NICo's documented way to upgrade an existing installation?**

A. Check out the target release and re-run setup.sh with the new image tags
B. Run clean.sh, then setup.sh
C. helm upgrade each chart manually in reverse order
D. Edit image tags in running Deployments with kubectl

<details>
<summary>Answer</summary>

**A.** Check out the target release and re-run setup.sh with the new image tags

setup.sh is idempotent and upgrades each phase in place, preserving Postgres data, Vault state, MetalLB config and the site UUID. clean.sh deletes everything, including released PersistentVolumes.

</details>

**2. You run `./setup.sh -y` and preflight reports an error. What happens?**

A. Setup stops; -y does not override preflight errors
B. Setup continues because -y accepts everything
C. Setup prompts you to continue
D. Setup skips the failing phase

<details>
<summary>Answer</summary>

**A.** Setup stops; -y does not override preflight errors

-y accepts routine prompts and preflight warnings only. Continuing past ordinary errors needs the explicit `--ignore-preflight-errors`, and database safety errors stay fatal even then.

</details>

**3. In which phase is NICo Core deployed?**

A. Phase 6
B. Phase 1b
C. Phase 5c
D. Phase 7i

<details>
<summary>Answer</summary>

**A.** Phase 6

1b is the Zalando postgres-operator, 5c is RMS and 7i is the REST site-agent. Core comes after all its prerequisites, in Phase 6.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/reference-install.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/reference-install.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md)

<a id="preflight-checks"></a>
## 7. Preflight checks (preflight.sh)

*Builds on: setup.sh orchestrator (ch. 17)*

### Before you read

- setup.sh fails in Phase 6 because a node can't resolve cluster DNS, after 20 minutes of installing other things. What would have been cheaper?

<details>
<summary>Answers</summary>

- **setup.sh fails in Phase 6 because a node can't resolve cluster DNS, after 20 minutes of installing other things. What would have been cheaper?** Checking DNS, along with every other precondition you can verify cheaply, before installing anything, and stopping with a clear message. That is what preflight.sh does.

</details>

### Explanation

`preflight.sh` is the validation script that runs **automatically at the start of every `setup.sh` invocation**. You can also run it on its own from `helm-prereqs/`, with `source ./preflight.sh` or `bash ./preflight.sh`. It checks everything first and then reports all problems together, so you can fix them in one pass. What it checks:

| Category | Examples |
|---|---|
| Environment variables | Image variables set where required; registry has no `https://` scheme; `NICO_SITE_UUID` valid if set; `KUBECONFIG` path exists |
| Required tools | `helm`, `helmfile`, `kubectl`, `jq`, `ssh-keygen`; Python 3 with PyYAML for the Core VIP check |
| Vault-free values (`--skip-vault` only) | Core values contain nothing that still needs Vault |
| `values/metallb-config.yaml` | Exists, valid YAML, at least one IPAddressPool, exactly one of BGP or L2 active, no leftover example hostnames |
| Cluster | API server reachable; at least **three schedulable nodes** |
| Per node | `net.bridge.bridge-nf-call-iptables=1`, `net.ipv4.ip_forward=1`, `kubernetes.default.svc.cluster.local` resolves |
| Registry | Registry host answers an HTTPS probe |
| Source tree | `rest-api/` is present |

Results come in three severities:

- **Errors** return exit code 1 and stop setup, even with `-y`. `--ignore-preflight-errors` continues past ordinary errors, but **database safety errors stay fatal**. The Vault-free values errors also stop setup even with `--ignore-preflight-errors`.
- **Warnings alone** prompt for confirmation, unless `-y` is set.

The per-node checks run a `busybox:1.36` pod on each node. On air-gapped clusters, set `PREFLIGHT_CHECK_IMAGE` to a local mirror.

The same idea works for any installer: check cheaply and early, gather every problem, then fail loudly.

**Analogy.** Preflight is a pilot's walk-around before take-off: tyres, fuel, flaps, all checked on the ground where fixing things is cheap. The analogy breaks down because a pilot can't override a missing wing. NICo's `--ignore-preflight-errors` does let you skip ordinary errors, though not database safety errors.

### Worked example: Reproduce three preflight checks by hand on a kind cluster

**Step 1: Create a cluster that resembles NICo's shape.**

```bash
cat > kind3.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
  - role: worker
EOF
kind create cluster --name pf --config kind3.yaml
```
kind keeps the NoSchedule taint on the control-plane node in multi-node clusters, so you need three workers to get three *schedulable* nodes.

**Step 2: Check required tools.**

```bash
for t in helm helmfile kubectl jq ssh-keygen; do
  command -v "$t" >/dev/null && echo "ok   $t" || echo "ERROR $t missing"
done
```

**Step 3: Count schedulable, Ready nodes.**

```bash
kubectl get nodes -o json | jq '[.items[]
  | select(((.spec.taints // []) | any(.effect == "NoSchedule" or .effect == "NoExecute")) | not)
  | select(any(.status.conditions[]; .type == "Ready" and .status == "True"))
] | length'
```
This prints `3`. With a single-node kind cluster it prints `1`, which preflight would treat as an error.

**Step 4: Check a kernel parameter on every node.**

```bash
for n in $(kind get nodes --name pf); do
  echo "$n ip_forward=$(docker exec "$n" cat /proc/sys/net/ipv4/ip_forward)"
done
```
NICo's preflight checks this and `bridge-nf-call-iptables` with a busybox pod per node instead.

**Step 5: Check cluster DNS from a pod.**

```bash
kubectl run dnscheck --rm -i --restart=Never --image=busybox:1.36 -- \
  nslookup kubernetes.default.svc.cluster.local
```
This is the same image NICo's per-node checks pull by default.

### Your turn: finish it

Complete this mini check so it errors when there are fewer schedulable, Ready nodes than NICo requires.

```text
N=$(kubectl get nodes -o json | jq '[.items[]
  | select(((.spec.taints // []) | any(.effect == "NoSchedule" or .effect == "NoExecute")) | not)
  | select(any(.status.conditions[]; .type == "___" and .status == "True"))
] | length')
if [ "$N" -lt ___ ]; then echo "ERROR: only $N schedulable nodes"; exit 1; fi
```

<details>
<summary>Answer</summary>

N=$(kubectl get nodes -o json | jq '[.items[]
  | select(((.spec.taints // []) | any(.effect == "NoSchedule" or .effect == "NoExecute")) | not)
  | select(any(.status.conditions[]; .type == "Ready" and .status == "True"))
] | length')
if [ "$N" -lt 3 ]; then echo "ERROR: only $N schedulable nodes"; exit 1; fi

</details>

### Your turn: on your own

For each preflight result, say whether `./setup.sh -y` stops, prompts or continues, and what you'd do:
(a) `values/metallb-config.yaml` has both the BGPAdvertisement and the L2Advertisement sections active.
(b) Only warnings were reported.
(c) `NICO_IMAGE_REGISTRY=https://my-registry.example.com/nico`.
(d) The cluster is air-gapped and per-node checks fail to pull their image.

<details>
<summary>Hint 1</summary>

Errors vs warnings: which one does -y override?

</details>

<details>
<summary>Hint 2</summary>

Look at the metallb and environment-variable rows of the preflight table.

</details>

<details>
<summary>Hint 3</summary>

There's a variable for the per-node check image.

</details>

<details>
<summary>Answer</summary>

(a) Error: exactly one advertisement mode must be active. Setup stops even with -y. Comment out one mode (BGP or L2) and re-run.
(b) With -y, warnings are accepted and setup continues. Without -y, it would prompt.
(c) Error: the registry must have no URL scheme. Setup stops. Use `my-registry.example.com/nico`.
(d) The per-node checks pull `busybox:1.36` by default and fail, which stops setup. Set `PREFLIGHT_CHECK_IMAGE` to a mirrored image and re-run.

</details>

### Explain it

In your own words: Why does preflight collect every problem and report them together, instead of exiting on the first failure? And why are some errors, such as database safety errors, not overridable at all?

### Check

**1. When does preflight.sh run?**

A. Automatically at the start of every setup.sh invocation, and on demand
B. Only when you pass --preflight
C. Only after Phase 6
D. Only on first install, not on upgrades

<details>
<summary>Answer</summary>

**A.** Automatically at the start of every setup.sh invocation, and on demand

The quick start says preflight runs automatically at the start of every setup.sh invocation. You can also run `source ./preflight.sh` yourself. Upgrades are setup.sh runs, so they include it.

</details>

**2. Which of these is not something preflight checks, according to the docs?**

A. That each BMC on the OOB network answers Redfish
B. At least three schedulable nodes
C. net.ipv4.ip_forward=1 on every node
D. The registry host responds to an HTTPS probe

<details>
<summary>Answer</summary>

**A.** That each BMC on the OOB network answers Redfish

Preflight validates the deployment environment: variables, tools, MetalLB config, cluster, nodes, DNS, registry and source tree. BMC discovery happens much later, through Site Explorer after ingestion.

</details>

**3. Which flag lets setup continue past ordinary preflight errors?**

A. --ignore-preflight-errors
B. -y
C. --debug
D. --skip-core

<details>
<summary>Answer</summary>

**A.** --ignore-preflight-errors

-y only accepts warnings and routine prompts. --ignore-preflight-errors continues past ordinary errors, but database safety errors stay fatal.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="build-task"></a>
## Build task: Build a mini setup.sh: preflight, helmfile, Kustomize overlay and Postgres with NICo's extensions

**Goal:** On a laptop kind cluster, write a small phased installer that mirrors NICo's setup.sh. It runs a preflight, installs a Helm release through helmfile, applies a Postgres database through a Kustomize site overlay and enables the btree_gin and pg_trgm extensions. A second run must succeed and change nothing.

**Why it matters for NICo:** NICo's setup.sh combines exactly these pieces: preflight, helmfile-managed Helm releases, Kustomize manifests, PostgreSQL with btree_gin and pg_trgm, and idempotent re-runs for upgrades. After building a small version yourself, you'll be able to read the real script's output, debug a failed phase and predict what a re-run will change.

**You need:**

- Docker (or Podman with kind's Podman provider), with about 4 GB of RAM free
- kind (`brew install kind`, or the binary from kind.sigs.k8s.io)
- kubectl 1.26+ (Kustomize is built in via `kubectl apply -k`)
- helm 3.12+ (or v4) and helmfile 0.162+
- helm-diff plugin: `helm plugin install https://github.com/databus23/helm-diff` (add `--verify=false` on Helm v4)
- jq, curl and openssl

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Create a 3-schedulable-node cluster</summary>

```bash
mkdir mini-site && cd mini-site
cat > kind.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
  - role: worker
EOF
kind create cluster --name mini --config kind.yaml
kubectl get nodes
```

</details>

<details>
<summary>Step 2: Create the chart and helmfile</summary>

```bash
helm create charts/hello
mkdir -p values
cat > values/hello.yaml <<'EOF'
replicaCount: 2
service:
  type: ClusterIP
  port: 80
EOF
cat > helmfile.yaml <<'EOF'
releases:
  - name: hello
    namespace: mini-site
    createNamespace: true
    chart: ./charts/hello
    values:
      - values/hello.yaml
EOF
helmfile diff   # should show a new release
```

</details>

<details>
<summary>Step 3: Write the Postgres Kustomize base</summary>

```bash
mkdir -p db/base db/overlays/site
cat > db/base/deployment.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
spec:
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:15
          env:
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-admin
                  key: password
            - name: POSTGRES_DB
              value: appdb
          ports:
            - containerPort: 5432
          readinessProbe:
            exec:
              command: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres"]
            initialDelaySeconds: 5
            periodSeconds: 5
EOF
cat > db/base/service.yaml <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: postgres
spec:
  type: ClusterIP
  selector:
    app: postgres
  ports:
    - port: 5432
      targetPort: 5432
EOF
cat > db/base/kustomization.yaml <<'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
EOF
```
The readiness probe uses TCP (`-h 127.0.0.1`) because the image's temporary init server listens only on a Unix socket. The pod is reported Ready only once the real server is up.

</details>

<details>
<summary>Step 4: Write the site overlay</summary>

```bash
cat > db/overlays/site/patch-db.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
spec:
  template:
    spec:
      containers:
        - name: postgres
          env:
            - name: POSTGRES_DB
              value: nico_system_nico
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              memory: 512Mi
EOF
cat > db/overlays/site/kustomization.yaml <<'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: mini-site
resources:
  - ../../base
labels:
  - pairs:
      site: laptop
    includeSelectors: false
patches:
  - path: patch-db.yaml
EOF
kubectl kustomize db/overlays/site | grep -nE 'namespace|nico_system_nico|site: laptop|memory'
```
The `env` entry is merged by `name`, so `POSTGRES_PASSWORD` from the base survives.

</details>

<details>
<summary>Step 5: Write preflight.sh</summary>

```bash
cat > preflight.sh <<'EOF'
#!/usr/bin/env bash
# Exit 0 = clean, 1 = errors, 3 = warnings only. Run with bash, not source.
set -u
ERRORS=0; WARNINGS=0
err()  { echo "ERROR: $*"; ERRORS=$((ERRORS+1)); }
warn() { echo "WARN:  $*"; WARNINGS=$((WARNINGS+1)); }
ok()   { echo "ok:    $*"; }
CLUSTER="${KIND_CLUSTER:-mini}"

# Environment variables
if [ -z "${SITE_NAME:-}" ]; then err "SITE_NAME is not set"; else ok "SITE_NAME=$SITE_NAME"; fi

# Required tools
for t in kubectl helm helmfile jq kind docker curl openssl; do
  if command -v "$t" >/dev/null 2>&1; then ok "$t found"; else err "$t not in PATH"; fi
done
if helm plugin list 2>/dev/null | grep -q '^diff'; then ok "helm-diff plugin"; else err "helm-diff plugin missing"; fi

# Cluster reachability and node count
if kubectl get --raw /readyz --request-timeout=5s >/dev/null 2>&1; then
  ok "API server reachable"
  N=$(kubectl get nodes -o json | jq '[.items[]
    | select(((.spec.taints // []) | any(.effect == "NoSchedule" or .effect == "NoExecute")) | not)
    | select(any(.status.conditions[]; .type == "Ready" and .status == "True"))
  ] | length')
  if [ "$N" -ge "${MIN_NODES:-3}" ]; then ok "$N schedulable nodes"; else err "only $N schedulable nodes (need ${MIN_NODES:-3})"; fi
else
  err "cannot reach the Kubernetes API server"
fi

# Per-node kernel parameters (kind nodes are Docker containers)
for n in $(kind get nodes --name "$CLUSTER" 2>/dev/null); do
  v=$(docker exec "$n" cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)
  [ "$v" = 1 ] && ok "$n ip_forward=1" || err "$n ip_forward=$v"
  b=$(docker exec "$n" cat /proc/sys/net/bridge/bridge-nf-call-iptables 2>/dev/null)
  [ "$b" = 1 ] && ok "$n bridge-nf-call-iptables=1" || warn "$n bridge-nf-call-iptables=${b:-missing}"
done

# Cluster DNS
if kubectl run "dnscheck-$$" --rm -i --quiet --restart=Never --image=busybox:1.36 \
     -- nslookup kubernetes.default.svc.cluster.local >/dev/null 2>&1; then
  ok "cluster DNS resolves"
else
  err "kubernetes.default.svc.cluster.local does not resolve from a pod"
fi

# Registry connectivity (any HTTP answer counts)
if curl -sS -o /dev/null --max-time 5 https://registry-1.docker.io/v2/; then ok "registry answers HTTPS"; else err "registry unreachable"; fi

echo "preflight: $ERRORS error(s), $WARNINGS warning(s)"
[ "$ERRORS" -gt 0 ] && exit 1
[ "$WARNINGS" -gt 0 ] && exit 3
exit 0
EOF
SITE_NAME=laptop bash preflight.sh; echo "exit=$?"
bash preflight.sh; echo "exit=$?"   # without SITE_NAME: an ERROR line and exit=1
```

</details>

<details>
<summary>Step 6: Write the phased, idempotent setup.sh</summary>

```bash
cat > setup.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ASSUME_YES=false; SKIP_DB=false
for arg in "$@"; do
  case "$arg" in
    -y) ASSUME_YES=true ;;
    --skip-db) SKIP_DB=true ;;
    *) echo "unknown option: $arg"; exit 2 ;;
  esac
done
NS=mini-site
confirm() {
  if $ASSUME_YES; then return 0; fi
  read -r -p "$1 [y/N] " a
  [ "$a" = y ] || [ "$a" = Y ]
}

echo "== Phase 0: preflight"
set +e; bash ./preflight.sh; rc=$?; set -e
if [ "$rc" -eq 1 ]; then echo "preflight errors: stopping"; exit 1; fi
if [ "$rc" -eq 3 ] && ! confirm "Preflight warnings. Continue?"; then exit 1; fi

echo "== Phase 1: namespace"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -

echo "== Phase 2: helm releases"
helmfile apply

if ! $SKIP_DB; then
  echo "== Phase 3: database (kustomize overlay)"
  kubectl -n "$NS" get secret postgres-admin >/dev/null 2>&1 || \
    kubectl -n "$NS" create secret generic postgres-admin \
      --from-literal=password="$(openssl rand -hex 16)"
  if confirm "Apply database overlay?"; then
    kubectl apply -k db/overlays/site
    kubectl -n "$NS" rollout status deploy/postgres --timeout=180s
    echo "== Phase 3b: extensions"
    kubectl -n "$NS" exec deploy/postgres -- psql -U postgres -d nico_system_nico \
      -v ON_ERROR_STOP=1 \
      -c 'CREATE EXTENSION IF NOT EXISTS btree_gin;' \
      -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'
  fi
fi
echo "== Done"
EOF
export SITE_NAME=laptop
bash setup.sh -y
```

</details>

<details>
<summary>Step 7: Re-run and prove idempotency</summary>

```bash
helm history hello -n mini-site     # note the latest REVISION
bash setup.sh -y                    # second run
helm history hello -n mini-site     # same REVISION: helmfile apply found no diff
helmfile diff                       # no changes reported
```
Also try `bash setup.sh` without `-y` to see the prompt, and `unset SITE_NAME; bash setup.sh -y` to see preflight stop the run even with `-y`.

</details>

**Check it works:** Run `kubectl -n mini-site exec deploy/postgres -- psql -U postgres -d nico_system_nico -tAc "SELECT extname FROM pg_extension ORDER BY 1"`. It must print `btree_gin`, `pg_trgm` and `plpgsql`. In addition: `helm list -n mini-site` shows `hello` as deployed; `kubectl -n mini-site get deploy postgres --show-labels` includes `site=laptop`; a second `bash setup.sh -y` exits 0 and leaves the `hello` revision in `helm history` unchanged; and `unset SITE_NAME; bash setup.sh -y` exits non-zero at Phase 0.

<details>
<summary>If you get stuck</summary>

- `Error: unknown command "diff" for "helm"` means the helm-diff plugin is missing. On Helm v4 install it with `--verify=false`.
- If preflight counts only 0 or 1 schedulable nodes, you probably made a single-node cluster, or the workers are still NotReady. Wait for `kubectl get nodes` to show Ready. kind keeps the NoSchedule taint on the control-plane in multi-node clusters.
- On macOS or some Linux hosts, `bridge-nf-call-iptables` may be missing inside kind nodes. The script treats that as a warning, so `-y` continues and an interactive run prompts.
- The first run pulls busybox:1.36 and postgres:15. If `rollout status` times out, check `kubectl -n mini-site describe pod -l app=postgres` for image pull or memory problems, then re-run setup.sh. It's safe to repeat.
- If psql reports `database "nico_system_nico" does not exist`, the pod first initialised with the base value `appdb`, because the base was applied without the overlay. Delete the pod (`kubectl -n mini-site delete pod -l app=postgres`). It has no persistent volume, so it reinitialises with the overlay's database name.
- `kubectl run ... --rm -i` can fail if an earlier dnscheck pod got stuck. List leftovers with `kubectl get pods | grep dnscheck` and delete them by name.

</details>

**Stretch goal:** Replace the plain Postgres Deployment with the Zalando operator, as NICo does. Add a helmfile release for chart `postgres-operator` from repo `https://opensource.zalando.com/postgres-operator/charts/postgres-operator` (add a `repositories:` entry), then a Phase 3 that applies a `kind: postgresql` resource (`teamId: nico`, name `nico-pg-cluster`, `numberOfInstances: 3`, `postgresql.version: "15"`) in a `postgres` namespace, and create the two extensions on its primary. To mirror NICo's layout, declare two databases on that cluster, `nico_system_nico` for Core state and `nico_rest` for the REST side. Then add a `values/hello-large.yaml` sizing file layered after `values/hello.yaml` and use `helmfile diff` to predict its effect before applying.

## Review notes

The draft was rewritten once using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (Kustomize): The analogy says a typo in a patch's resource name "silently fails to match, or causes an error". Current Kustomize stops with a 'no matches' error when a patch targets a resource that doesn't exist, so it does not fail silently. *Fix:* Say that a patch whose kind/name matches no resource makes the build fail with an error, while the transparent sheet always lines up.
- **minor** (PostgreSQL (Zalando operator)): The chapter calls 8 CPUs / 16 GiB the Postgres defaults, as the sizing guide does. The quick start shows a sample `postgresql` block in helm-prereqs/values.yaml with 4 CPU / 4Gi limits, described as conservative dev defaults. Learners who open values.yaml may see different numbers from the ones the lesson states. *Fix:* Add a sentence saying the shipped values block may show smaller dev defaults (the quick start shows 4 CPU / 4Gi), and that the 8 CPU / 16 GiB figures and the sizing table come from the sizing guide. Learners should check their own values.yaml.

---

[← 16-scale-sizing.md](16-scale-sizing.md) · [18-cryptography.md →](18-cryptography.md)
