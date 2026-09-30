# kiancode

An Apache-2.0 agent service with durable tasks, scoped memory, model adapters and outbound device connectors. Node.js 24 or later is required.

## Local use

```sh
npm ci
npm run check
node dist/cli.js init
```

Edit `.runtime/config.json` to add a model provider and model. The development token is generated in `.runtime/development.env`; the service binds to loopback.

```json
{
  "mode": "development",
  "host": "127.0.0.1",
  "port": 8768,
  "auth": { "developmentTokenEnv": "KIANCODE_DEV_TOKEN" },
  "providers": [{ "id": "local", "type": "openai-compatible", "baseUrl": "http://127.0.0.1:8000/v1", "locality": "local" }],
  "models": [{ "id": "local-model", "model": "YOUR_MODEL_ID", "providerId": "local", "locality": "local", "capabilities": ["streaming"] }],
  "serverWorkspaceRoots": []
}
```

Provider types are `openai-compatible`, `ollama` and `device`. Set `apiKeyEnv` to the name of an environment variable instead of putting a credential in JSON. Only advertise model capabilities that have been verified against the selected model. `streaming`, `tools` and `vision` are probed separately; model architecture, including MoE, is independent of the `single`, `experts` and `moa` orchestration strategies.

```sh
node dist/cli.js serve
node dist/cli.js chat --message 'Hello' --model-policy local
```

The CLI prints conversation and task identifiers for continuation. API requests use `Authorization: Bearer …`. Chat submission returns a durable task; `/v1/tasks/:id/stream` provides SSE events with resumable sequence identifiers.

Skills and MCP servers are owner-scoped, versioned plugins. An owner with `plugin:manage` installs a version through `POST /v1/plugins/:id/versions`, then activates that exact version through `PATCH /v1/plugins/:id`; tasks snapshot active versions so a later update does not change running work. Skill files are data and never expand the caller's grants. MCP calls require both `plugin:use` and `mcp:<plugin-id>`.

Operators allow remote MCP origins and fixed stdio command profiles in configuration. Plugin content may select a profile but cannot supply a subprocess command, working directory or raw secret. Map each child-process environment variable to a named service environment variable:

```json
{
  "plugins": {
    "allowedOrigins": ["https://mcp.example.com"],
    "commandProfiles": [{
      "id": "reviewer",
      "command": "/opt/kiancode-tools/reviewer",
      "args": [],
      "environmentEnv": { "SERVICE_API_KEY": "REVIEWER_API_KEY" }
    }]
  }
}
```

Remote MCP header values use `{ "envRef": "ENVIRONMENT_VARIABLE" }`. Keep origins exact, use HTTPS except for loopback development, and grant only the tool capabilities required by the principal and workspace.

## Components

- Conversations, raw messages, tasks, events, memory and artifact metadata share stable identifiers in the primary database.
- The runtime executes a model/tool/check loop. Ask and plan modes exclude write tools; act mode uses scoped approvals. Unknown external outcomes stop for reconciliation.
- Expert and MoA tasks create durable child tasks with a shared budget and a single parent integration. Child failure does not silently produce a successful parent task.
- Workspace tools check roots, symlinks and content hashes. Restore only undoes a checkpoint while its written content is unchanged. Terminal capability is explicit; a working directory is not an operating-system sandbox.
- `workspace.export` turns one selected workspace file into a task-bound artifact. Grant `workspace:export` to the principal and workspace; remote Mac workspaces must also grant and report it in the device connector. Agent and workspace-operation use pause until the exact external action is approved. Exports are limited to 6 MiB and `.txt`, `.md`, `.csv`, `.json`, `.pdf`, `.docx`, `.png`, `.jpg`, `.jpeg` or `.webp`. `allowCloud` continues to control model routing, not an explicitly approved export.
- Device connectors pair through a one-use code, connect outbound with a device bearer, and journal execution before returning results. An offline device suspends dependent work.
- Memory records retain scope, provenance, validity and replacement links. Document import retains artifact/page citations. Summaries do not replace the message history.
- MCP and skill versions are pinned. Operators define fixed stdio command profiles and allowed remote origins; plugin credentials come from named environment variables.
- Account owners can save provider and model overrides. Provider credentials use AES-GCM with the key named by `providerManagement.credentialKeyEnv`; a changed provider or model must pass capability probing before it can run.
- Notifications retain owner timezone and quiet hours. Task completion, failure, unknown outcomes and approval requests are durable; push delivery is handled by a separate APNs adapter without exposing device tokens through the API.
- Schedules and webhook or device-online triggers use immutable execution snapshots and revalidate current authorization before enqueueing work. Cron schedules require an IANA timezone; imported legacy schedules remain disabled drafts until the owner reviews them. Both execution paths default to disabled and require explicit `automations` configuration.

## Deployment

Production uses PostgreSQL and an authenticated HTTPS attachment service. Run the API under systemd using `deploy/kiancode.service` and `deploy/config.example.json` as templates. Runtime checkpoints default to `/var/lib/kiancode/checkpoints` in production and can be set with `stateDirectory` or `checkpointDirectory`; keep them on a path writable by the service account. Keep configuration, service credentials and private workspaces outside the source tree. Grant only the workspace roots and capabilities needed by the service account.

`deploy/postgres/init-app.sh` creates a dedicated role and database when run by a PostgreSQL administrator. It requires `APP_USER`, `APP_DATABASE`, `POSTGRES_USER` and a mounted `/run/secrets/app_password`; the identifiers and password are deliberately restricted to the script's accepted character set. Put the resulting connection string in the environment variable named by `database.urlEnv` (`DATABASE_URL` by default), then validate the complete production configuration before starting the service:

```sh
node dist/cli.js config-check --config /etc/kiancode/config.json
```

Production startup fails closed when that PostgreSQL environment variable is absent. `database.sqlitePath` is for development and tests only.

For Account authentication, keep `auth.issuer` set to the public canonical issuer. Set `auth.accountApiUrl` only when Core should call Account through a separate HTTPS or loopback HTTP service endpoint; identity IDs continue to derive from `auth.issuer`.

Terminal commands receive only PATH, locale and terminal metadata by default. Map any required command credential explicitly through `terminal.environmentEnv`. Production server workspaces require `terminal.isolation: "bubblewrap"`; the sandbox mounts only the assigned workspace as writable, keeps networking isolated unless both the operator and workspace grant it, and fails closed when user namespaces are unavailable. Add a Node installation outside `/usr` through the restricted `terminal.readOnlyPaths` allowlist. Device connectors execute under the device account and their declared workspace grants.

On Ubuntu hosts that restrict unprivileged user namespaces, install the dedicated executable and its AppArmor profile as root after creating the `kiancode` service account:

```sh
install -d -o root -g root -m 755 /usr/local/libexec
install -o root -g kiancode -m 750 /usr/bin/bwrap /usr/local/libexec/kiancode-bwrap
install -o root -g root -m 644 deploy/kiancode-bwrap.apparmor /etc/apparmor.d/kiancode-bwrap
apparmor_parser -r /etc/apparmor.d/kiancode-bwrap
```

Set `terminal.binary` to `/usr/local/libexec/kiancode-bwrap`, then verify a terminal command under the service account with network isolation. The profile applies only to that root-owned executable; keep the host's general namespace restrictions enabled.

`Dockerfile` builds an independent core distribution. `kiancode blobs` runs the attachment service; it supports `--directory`, `--host`, `--port`, `--token-file`, `--tls-key` and `--tls-cert`. Clients must trust the storage certificate authority.

`deploy/backup-postgres.sh` produces a checksummed custom-format dump. `deploy/restore-postgres.sh` verifies that checksum and restores only into a new `restore_` database:

```sh
CONTAINER='postgres-container' DATABASE='kiancode' BACKUP_DIRECTORY='/secure/backups/kiancode' deploy/backup-postgres.sh
CONTAINER='postgres-container' BACKUP_FILE='/secure/backups/kiancode/kiancode-YYYYMMDDTHHMMSSZ.dump' RESTORE_DATABASE='restore_kiancode_YYYYMMDD' deploy/restore-postgres.sh
```

Read back owner-scoped tasks, events and representative record counts from the restored database before changing any service connection. Back up attachment objects, configuration and their required encryption material separately with restricted permissions; a database dump alone is not a complete restore. Keep the serving database unchanged until both database and attachment verification pass.

Account systems and product channels are adapters. Deployment-specific integrations, native clients, credentials and model assets belong outside this repository. This repository contains no personal production configuration or recovered proprietary runtime code. Legacy source labels retained in migration records are provenance only; they do not load or depend on another runtime.

## Verification

`npm run check` runs TypeScript checking, behavior tests and the distributable build. Real deployment, PostgreSQL restore, provider capability, tool isolation, signed-device and external-adapter checks remain separate release gates.

## License

Apache-2.0. Dependencies retain their own licenses.
