# DevHub project stories and adoption criteria

This document defines the intended workflows for bringing existing applications under the DevHub project manager and connecting them to shared local services. The stories are acceptance criteria, not a release promise.

Status below reflects the repository on 2026-11-03. Update a status when implementation lands. Any command labeled **planned** describes the target interface and may not work yet.

## Product boundary and current status

DevHub has two parts:

- **Shared infrastructure** is the existing Compose stack of PostgreSQL, MySQL, Redis, Meilisearch, Mailpit, Adminer, Dozzle, and RabbitMQ.
- **The project manager** is the local CLI, loopback API, and control panel for explicitly approved application folders.

The manager is a local development tool, not a hosted platform or a hostile-code sandbox. It must preserve the existing Compose project, container, volume, port, profile, and network identities in [compose.yml](../compose.yml). It must not silently adopt or stop unrelated applications.

The existing Bash CLI in [bin/devhub](../bin/devhub) contains the shared-infrastructure commands **up**, **down**, **restart**, **ps**, **logs**, **open**, **db**, **doctor**, **version**, and **help**. The source tree also has shared contracts and local safety foundations in [src/contracts.ts](../src/contracts.ts), [src/state.ts](../src/state.ts), [src/guard.ts](../src/guard.ts), [src/git.ts](../src/git.ts), [src/runtime/executor.ts](../src/runtime/executor.ts), and a composition entry point in [src/main.ts](../src/main.ts).

The manager services are implemented and composed by [src/main.ts](../src/main.ts): Catalog ([src/catalog](../src/catalog/)), Discovery ([src/discovery](../src/discovery/)), Runtime ([src/runtime](../src/runtime/)), Operations ([src/operations](../src/operations/)), Maintenance ([src/security](../src/security/)) and the loopback API ([src/api](../src/api/)). [bin/devhub](../bin/devhub) dispatches **root**, **project**, **maintenance**, **security**, **setup**, **serve**, **pair**, and **presets** to Bun, and **infra ...** to the existing Bash commands. The React control panel under [apps/web](../apps/web/) is connected to the API.

## Stories

### US-01: Keep shared infrastructure working

**Actor and need:** As an existing application maintainer, I want the established shared services and commands to keep working while project management is added, so current development environments keep their identity and data.

**Scope:** Preserve the Compose stack and its Bash entry points. New project operations act only on registered project components. Explicit shared-infrastructure commands remain separate.

**Acceptance criteria:**

- The eight existing service and container identities, **core** and **async** profiles, external **dev-shared-net**, published ports, named volumes, and RabbitMQ hostname remain unchanged.
- Existing **devhub up**, **down**, **restart**, **ps**, **logs**, **open**, **db**, and **doctor** behavior remains available without requiring Bun.
- Any future **devhub infra ...** form delegates to the existing Bash implementation with its existing arguments and Compose identity.
- A project start, stop, restart, or removal cannot stop, remove, or claim shared infrastructure. Removing a project unregisters it only.

**Verification method:** The infrastructure contract check compares the frozen Compose identity. CLI Bats fixtures check legacy dispatch and ensure project operations do not generate shared-resource teardown arguments.

**Dependencies:** Existing Compose and Bash CLI; lead-owned compatibility dispatch.

**Current status:** **Implemented.** The stack and Bash commands are unchanged (checked by `tests/infra-contract.py`). **devhub infra ...** delegates to the Bash implementation with its original arguments and Compose identity (`tests/cli.bats`). Catalog and Runtime refuse shared infrastructure Compose identities (`devhub`, `dev-infra`, `devhub-infra`, `dev-shared-net`, `infra-*`) and shared data volumes; project stop issues only `stop` on the component's own services, and project removal deletes catalog rows only.

**Current command example:**

~~~sh
devhub up
devhub ps
devhub doctor
devhub down
~~~

### US-02: Approve roots and discover existing projects in place

**Actor and need:** As a developer with applications in several folders, I want to approve workspace roots and discover repositories without moving or rewriting them, so I can manage the folders where they already live.

**Scope:** Root approval, bounded metadata-only scans, repository and worktree discovery, and explicit grouping of related folders.

**Acceptance criteria:**

- **root add** accepts a path explicitly selected by the local operator. Discovery scans only approved roots and stays within canonical real paths.
- Discovery can identify Git repositories and worktrees, Compose files, known manifests, and static Make targets without running project scripts, hooks, or Makefiles.
- Symlink escapes and protected DevHub, state, and installer paths are refused. A broad approved root may contain protected subtrees, but scans skip those subtrees.
- Existing folders are registered in place. No folder is moved, copied, or modified during discovery.
- Multiple detected folders are grouped only after the operator selects them. Their component paths remain inside the selected project root.

**Verification method:** Catalog, discovery, and CLI tests use temporary roots and inert Git/Compose fixtures. Include sibling paths, linked worktrees, symlink escapes, and a broad root containing a protected subtree.

**Dependencies:** Catalog root policy, Discovery, and CLI approval flow.

**Current status:** **Implemented.** Catalog root policy and Discovery are composed; tests cover symlink escapes, skipped subtrees, paths outside approved roots, and grouping a Compose backend with a native Vite frontend.

**Command example:**

~~~sh
devhub root add ~/code
devhub project add --path ~/code/shop --name shop --preset compose-existing --apply
devhub project list
~~~

### US-03: Preview project presets before writing files

**Actor and need:** As a developer starting or configuring an application, I want a preset or detected setup to be previewed before files are created, so I can see exactly what DevHub proposes.

**Scope:** Interactive and flag-based project addition for Symfony, Laravel, and Node Docker backends with a native frontend where detected, existing Compose projects, native projects, and custom local configuration.

**Acceptance criteria:**

- Supported preset IDs are **symfony-docker**, **laravel-docker**, **node-docker**, **compose-existing**, **native**, and **custom**.
- Interactive setup and **project add --path ... --name ... --preset ... --apply** use the same discovery preview and apply path.
- Preview lists planned files, components, Compose identity, warnings, and detected ports. Exact configured commands remain in the local CLI preview; browser DTOs omit execution arguments and environment contents. No file is written before explicit apply.
- Apply creates only files that do not already exist. It never overwrites project files. A partial apply failure removes only files created by that apply and does not register an incomplete project.
- Existing .env content is preserved. Within a project .env, only **COMPOSE_PROJECT_NAME** and **COMPOSE_PROFILES** are accepted as Compose controls; other **COMPOSE_*** settings are rejected without rewriting the file.
- Existing Compose identity is preserved. An explicit project name resolves ambiguity by selecting the existing identity; renaming a running stack is outside this workflow.

**Verification method:** Discovery and CLI tests compare preview output with fixture files, prove apply is exclusive, and verify existing bytes are unchanged on refusal or failure.

**Dependencies:** Discovery, Catalog validation, and CLI preview/apply flow.

**Current status:** **Implemented.** The six presets are served by Discovery. Tests cover side-effect-free preview, refusal of existing target files without modification, rollback of only the files created by a failed apply, expired setup plans, and rejected project `.env` Compose controls.

**Command example:**

~~~sh
devhub project add --path ~/code/api --name api --preset laravel-docker --apply
devhub project show api
~~~

### US-04: Operate a Docker backend with a native frontend

**Actor and need:** As a developer running a hybrid application, I want to start and inspect its Docker backend and native frontend together, so I can use the same local workflow for mixed stacks.

**Scope:** Compose and native lifecycle, dependency ordering, readiness, status, and bounded logs on the current local Linux host.

**Acceptance criteria:**

- Docker uses the current context only after verifying it is local. DevHub does not silently switch to the default context.
- Native processes use the local user's systemd session and D-Bus. Setup does not install system packages, use sudo, or create system-wide units.
- Start orders selected components by their declared dependencies. Stop orders them in reverse. Operations never stop shared infrastructure or unregistered resources.
- If startup partially fails, DevHub records failure and leaves components already started running for diagnosis. It does not roll them back automatically.
- Status distinguishes process state from readiness and reports unknown or failed checks honestly.
- Project .env accepts only the approved **COMPOSE_PROJECT_NAME** and **COMPOSE_PROFILES** controls. The project keeps its existing Compose identity.
- No project operation runs a database schema migration or claims to roll one back.

**Verification method:** Runtime and Operations tests use an injected executor and temporary project fixtures. Cover dependency order, local-context refusal, readiness, native unit ownership, bounded logs, and partial-start failure that leaves prior components running. Do not start live project services as a test.

**Dependencies:** Catalog, Runtime, Operations, guarded executor, and Discovery component definitions.

**Current status:** **Implemented.** Runtime verifies the local Docker context and drives Compose and user systemd units; Operations covers topological start, reverse stop, readiness deadlines, idempotency, and partial-start failure that leaves started components running.

**Command example:**

~~~sh
devhub project start shop
devhub project status shop
devhub project logs shop
devhub project stop shop
~~~

### US-05: Pair with a local control panel and inspect project logs

**Actor and need:** As a local developer, I want to pair a browser with my DevHub process and view project status and logs, so I can inspect work without exposing a remote service.

**Scope:** Explicit CLI pairing, authenticated API requests, project-scoped logs, and the control-panel views.

**Acceptance criteria:**

- The controller binds only to **127.0.0.1**, on port **8040** by default. Starting the server does not silently create a pairing code.
- **devhub pair** explicitly creates a one-time code with at least 128 bits of entropy, a maximum five-minute lifetime, and single use.
- Pairing is the only unauthenticated API route. Sessions use an HttpOnly, SameSite=Strict cookie; tokens are not stored in browser local storage.
- Requests require exact loopback Host and Origin checks. A development frontend origin is trusted only when explicitly supplied with **--dev-origin**.
- Logs are bounded and project-scoped. Selecting another project changes the log stream; it cannot reveal the previous project's logs.
- Failed authentication, expired sessions, and API errors are visible. The panel never reports a successful operation unless the backend reports it.

**Verification method:** API tests exercise pairing replay/expiry, origins, sessions, project scope, and bounded log streams through in-process requests. Check UI TypeScript and source wiring without starting a server or running frontend tests.

**Dependencies:** API, Catalog, Operations, CLI pairing, and control-panel integration.

**Current status:** **Implemented.** The API covers pairing expiry and attempt limits, Host and Origin checks, eight-hour sessions, logout, capped log streams, and DTOs that never return argv, env files, or validation commands. The control panel is connected, with page URLs per view. **devhub serve --dev** also starts the Vite panel server.

**Command example:**

~~~sh
devhub pair
devhub serve
devhub serve --dev
devhub serve --dev-origin http://127.0.0.1:5175
~~~

### US-06: Inspect containers and scan local images

**Actor and need:** As a developer reviewing a local stack, I want a read-only inventory and explicit image scans, so I can see what is running and what the scanner found without DevHub adopting unrelated containers.

**Scope:** Current local Docker inventory, explicit scans of locally available image IDs, findings, fixability, and scanner database freshness.

**Acceptance criteria:**

- Inventory uses the verified current local Docker context and exposes only the approved metadata subset.
- Containers without an explicit project mapping remain observed-only. Inventory never grants permission to start, stop, or modify them.
- A scan runs only after an explicit request for an existing local image. DevHub does not install a scanner, log into a registry, or upload images to a cloud service.
- Results identify the exact image ID, scanner, scan time, findings, available fixed versions, and vulnerability database freshness. Unknown freshness and scanner failures are reported as such.
- A successful scan is not treated as proof that a vulnerability was fixed.

**Verification method:** Runtime and maintenance tests inject inventory and scanner results. Cover unmapped containers, missing images, scanner failure, unknown database freshness, and findings with no fix. No live Docker or scanner call is part of a test.

**Dependencies:** Runtime inventory, Maintenance scanner adapter, API, and panel integration.

**Current status:** **Implemented.** Runtime inventory keeps unlabeled containers observed-only; Maintenance runs Trivy only on explicit request and records scanner, scan time, findings, and database freshness when reported. Scanner absence, malformed output, and remote Docker contexts are recorded as failures. The panel shows filterable container and scan inventories with a per-image Scan action, and a container's detail panel follows its Docker logs live while it stays open (read-only, also for containers linked to no project).

### US-07: Review and validate a replacement image reference

**Actor and need:** As a developer maintaining an application image, I want to enter a candidate image reference, review the exact source change, and validate the exact candidate before activation, so an image update is deliberate and evidence-backed.

**Scope:** A checked image-reference input, narrowly supported Dockerfile or Compose source edits, isolated candidate validation, and a separate activation step.

**Acceptance criteria:**

- The operator can type a replacement image reference. DevHub validates the supported reference syntax before changing a file and rejects flags, newlines, unresolved variables, and malformed or unsupported references.
- A source mapping must already associate the selected component with the target file and image. Preview changes one Dockerfile **FROM** operand or one Compose **image** scalar and shows only the changed operand.
- Apply rechecks the source hash and scoped Git tree, then creates a dedicated local branch. It does not push.
- Validation prepares a separate candidate. Application checks run without network access, host mounts, project secrets, shared services, or shared data volumes. It records the exact candidate image ID and scan result.
- Activation is a separate explicit action. It requires successful, current validation evidence, rechecks source/runtime/volume identity, and selects the exact validated candidate.
- Unsupported validation, changed source, stale evidence, a major database version change, or missing checks blocks activation. DevHub performs no schema migration and makes no data rollback claim.

**Verification method:** Maintenance tests use temporary repositories plus injected scanner and executor fixtures. Cover successful preview/apply/validate/activate and stale source, invalid reference, missing fix, failed checks, and candidate identity mismatch. Do not build or activate a live application image.

**Dependencies:** Catalog source mapping, Runtime snapshots, Maintenance, Git safety helper, API, and panel integration.

**Current status:** **Implemented.** Maintenance previews one Dockerfile **FROM** operand (named and dotted stages included) or one Compose **image** scalar, refuses database major changes, stale or dirty sources, and unmapped sources, applies on a dedicated local branch, validates the candidate with `--network none`, and activates only the exact validated image. The panel exposes the remediation flow under `/maintenance/remediation`.

### US-08: Adopt shared services one project at a time

**Actor and need:** As an application maintainer, I want to connect one project at a time to DevHub's shared services, so I can simplify project Compose files without unexpectedly moving or deleting application data.

**Scope:** Follow-up work in each explicitly selected application repository. This DevHub delivery provides adoption guidance and the existing networking helper; automated rewrites of external repositories are not part of this delivery. Adoption does not transfer databases or rewrite schemas.

**Acceptance criteria:**

- The operator selects the project and each shared dependency to adopt. DevHub shows the target service and connection method before the project configuration is changed.
- Containers use the existing external **dev-shared-net** and stable service identities such as **infra-postgres**, **infra-mysql**, **infra-redis**, **infra-meilisearch**, **infra-mailpit**, and **infra-rabbitmq**. Native host processes use the configured loopback port.
- The project's Compose project name, application container names, and application-owned named volumes are preserved.
- Adoption does not copy database contents, run migrations, delete project services, remove volumes, or change shared service identities. If required data is not already present in the selected shared service, the application stays on its current service until a separate data-migration decision is made.
- A project is considered adopted only after its configured application check confirms the intended connection. Other projects remain unchanged.

**Verification method:** Use inert project fixtures and a mocked connection check to verify the proposed network and connection mapping. Confirm the shared Compose identity contract remains unchanged. A later adoption requires the project owner to confirm application health explicitly. This verification does not touch live projects or shared services, and performs no data copy, migration, volume removal, or automatic project switch.

**Dependencies:** Existing shared infrastructure, project approval and discovery, safe preview/apply, and a user-provided connection configuration.

**Current status:** **Guidance only; manager workflow not started.** Shared services, the external network, **devhub db create**, the network helper (`data/scripts/connect-project-network.sh`), and the README connection guidance exist. The presets register a project with its existing Docker configuration but do not propose a shared-service connection mapping. There is no adoption preview, connection check, or adopted state, and no data transfer is included in this scope.
