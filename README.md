# Obsidian WebSync — 0.1.16

> **Experimental version — not production-ready.** The development sync engine received limited checks on one real Mac against a legacy server; 0.1.16 changes release packaging and version metadata, not that sync engine. Real mobile devices, production migration, rollback and concurrent-device conflicts have not been validated for this version. Its schema-2 storage changes cannot be safely rolled back by simply restarting the old server. Do not install this version in an active vault, run it against a production service or bucket, or treat a connected status as proof that all devices received every change. All procedures below are for isolated synthetic test environments only.

Before any production rollout, independently back up the vault, server state and cloud objects; verify restoration and migration/rollback in isolation; test real devices and coordinate their upgrades. Overlapping edits or deletion-versus-edit conflicts can still require manual resolution. Mobile background execution, uninterrupted network connectivity and sub-second delivery are not guaranteed. Cloud manifests are not protected against concurrent independent server writers, large uploads are not resumable, and unreferenced blobs do not yet have a safe automatic cleanup policy.

An isolated simulation of the old 0.1.15 client showed that a local edit made
inside its 2.5-second suppression window after a remote write may not be
queued. The development client rechecks changes in that window in simulated
tests, and one such check succeeded on a real Mac. This does not establish the
cause of any particular user's delayed edit or prove other devices are safe.

WebSync is a private realtime sync stack for an Obsidian vault. It is designed for a personal multi-device setup where a lightweight Obsidian plugin talks to a Node.js sync service, and the service persists files plus the manifest in Tencent COS.

The important design choice is that COS credentials never live in the Obsidian plugin. Clients only know the WebSocket endpoint, vault id, and sync token.

## Architecture

```text
Obsidian plugin
  - Watches vault file changes.
  - Sends local changes over WebSocket.
  - Pulls remote changes and writes them to the vault.
  - Keeps an offline queue, adaptive debounce policy, and conflict copies.
  - Merges non-overlapping Markdown edits with a three-way merge.
  - Requires a coordinated per-device upgrade of WebSync's own executable files.

Node sync service
  - Authenticates clients with a shared token.
  - Maintains revisioned manifest state.
  - Broadcasts realtime changes over WebSocket.
  - Serves chunked manifest/file HTTP endpoints.
  - Keeps an append-only operation log for diagnostics.
  - Writes files and manifest snapshots to COS.

Server vault mirror
  - Runs as a read-only subscriber next to the sync service.
  - Applies the current manifest at startup.
  - Subscribes to realtime WebSocket changes and keeps a filesystem mirror warm for server-side agents.
  - Preserves dirty local mirror files under a conflict directory before applying remote content.

Tencent COS
  - Reads legacy path-addressed files under COS_PREFIX/files/ and stores new versions under COS_PREFIX/blobs/sha256/.
  - Stores the current manifest under COS_PREFIX/meta/manifest.json.
```

## Repository Layout

```text
src/plugin/        Obsidian plugin code
src/server/        Node.js sync service
src/shared/        Protocol and path rules shared by client/server
scripts/           Build, install, and seed helpers
deploy/systemd/    Example systemd unit
tests/             Vitest coverage for manifest, hub, paths, and plugin sync logic
manifest.json      Obsidian plugin manifest
styles.css         Obsidian plugin styles
```

Generated build output goes to `dist/` and is ignored by git. Runtime state such as `data/manifest.json`, `data/oplog.jsonl`, `mirror-state.json`, and `mirror-conflicts/` is also ignored and must not be committed.

## Current Behavior

- Realtime sync uses WebSocket.
- Startup sync scans local files and reconciles with the remote manifest.
- Offline local changes are queued.
- Remote changes are pulled and written locally.
- Folder changes, Markdown edits, plugin resources, and binary files use different debounce delays.
- Sync direction is configurable per device: two-way, pull-only, or push-only.
- Non-overlapping Markdown conflicts are merged client-side and retried automatically.
- Overlapping Markdown conflicts pause the affected item while retaining the local content; stale binary uploads may be preserved as `(... conflict from DEVICE TIMESTAMP)` files.
- Conflict device names are resolved automatically from the local host/platform; they are not user-configured plugin settings.
- Empty folders are synced through `.obsidian/websync-folders.json`.
- The command palette has `WebSync: Show sync diagnostics` for queue, inflight, revision, last sync, and last error state.
- The service exposes an authorized `GET /oplog?after=REV&limit=N` endpoint for recent operation diagnostics.
- The optional server mirror process keeps `/home/ubuntu/obsidian-vaults/jonaszchen` close to realtime for Hermes and other server-side agents.
- Snapshot tombstones move clean local files to local trash; a deletion conflicting with local changes is blocked. Empty folder creation and pruning are controlled by `.obsidian/websync-folders.json`.
- `.obsidian` sync defaults to a standard stable set:
  - synced: `.obsidian/community-plugins.json`
  - synced: `.obsidian/websync-folders.json`
  - synced in `Standard`: stable Obsidian config such as `app.json`, `appearance.json`, `core-plugins.json`, `daily-notes.json`, `graph.json`, and `types.json`
  - not automatically overwritten: `.obsidian/plugins/websync/main.js`, `manifest.json`, and `styles.css`
  - optionally synced: selected plugin resource folders under `.obsidian/plugins/<plugin-id>/`
  - never synced: plugin `data.json`, WebSync queues, workspaces, sync credentials, and other device-local Obsidian config

## Requirements

- Node.js 20+
- npm
- Tencent COS bucket
- A server reachable by HTTPS/WSS
- Obsidian desktop or mobile

## Setup (isolated testing only)

Install dependencies:

```bash
npm ci
```

Copy and edit the server environment:

```bash
cp .env.example .env
```

Important variables:

```bash
OBS_SYNC_HOST=127.0.0.1
OBS_SYNC_PORT=5212
OBS_SYNC_VAULT_ID=default
# Optional: comma-separated legacy IDs accepted during bootstrap migration.
OBS_SYNC_VAULT_ALIASES=
OBS_SYNC_TOKEN=change-me
OBS_SYNC_DATA_DIR=/home/ubuntu/obsidian-sync/data

COS_BUCKET=your-cos-bucket
COS_REGION=ap-guangzhou
COS_PREFIX=_websync
COS_SECRET_ID=change-me
COS_SECRET_KEY=change-me
```

Never commit `.env` or runtime state under `OBS_SYNC_DATA_DIR`.

## Build

Build both server and plugin:

```bash
npm run build
```

Build only the plugin:

```bash
npm run build:plugin
```

Build only the server:

```bash
npm run build:server
```

## Install Plugin Locally (isolated test vault only)

By default this installs into `~/Documents/Obsidian`:

```bash
npm run install:plugin
```

Override the vault path:

```bash
OBSIDIAN_VAULT_PATH=/path/to/vault npm run install:plugin
```

Optional install-time settings:

```bash
OBS_SYNC_SERVER_URL=wss://websync.example.com/sync \
OBS_SYNC_TOKEN=your-token \
npm run install:plugin
```

## Client Sync Settings

Each device can choose a sync direction:

- `Two-way`: upload local changes and apply remote changes.
- `Pull only`: apply remote changes but never upload this device's local changes.
- `Push only`: upload local changes but do not write remote changes into this device.

Obsidian config sync has three modes:

- `Minimal`: sync only WebSync bootstrap files and `.obsidian/community-plugins.json`.
- `Standard`: additionally sync stable Obsidian settings such as attachment location, appearance, core plugin list, daily notes, graph, backlinks, canvas, and property types.
- `Selected plugins`: includes `Standard`, then additionally syncs resources for comma-separated plugin IDs, such as `dataview` or `obsidian-marp-plugin`.

Plugin `data.json` files are always excluded because they often contain tokens, local paths, or device-specific state.

## Run Server (isolated testing only)

After building:

```bash
node dist/server/index.cjs
```

For systemd, adapt:

```text
deploy/systemd/obsidian-sync.service
```

To keep a hot server-side vault mirror for agents, also run:

```bash
node dist/server/mirror.cjs
```

For systemd, adapt:

```text
deploy/systemd/websync-vault-mirror.service
```

The mirror is intentionally pull-only. It never sends `put` or `delete`; server-side edits should still be pushed with the normal WebSync helper after the agent finishes a coherent change.

A future production deployment would need Caddy, Nginx, or another reverse proxy in front of the service and expose:

```text
https://your-domain/healthz
wss://your-domain/sync
```

Useful authenticated HTTP endpoints:

```text
GET /manifest-page?offset=0&limit=50
GET /file-chunk?path=Memo%2Fa.md&offset=0&length=32768
GET /oplog?after=0&limit=100
```

All non-health endpoints require `Authorization: Bearer <OBS_SYNC_TOKEN>`.

## Seed Remote State

Both historical seeding commands are disabled in this development version.
Direct COS seeding can replace the cloud manifest or delete an entire prefix;
the vault seeder can overwrite or resurrect remote files based on a snapshot.
A safe initialization, migration and recovery procedure must be designed and
tested before either command is enabled.

The revised server checks local and cloud manifests against each other and
refuses ambiguous states. Do not delete or manually rewrite either manifest to
force a startup; protect independent backups and investigate recovery first.

## Mobile Bootstrap

If a mobile device does not have WebSync installed yet, it needs a bootstrap path. Use any one-time bootstrap method to deliver:

- `.obsidian/community-plugins.json`
- `.obsidian/plugins/websync/`
- `.obsidian/plugins/websync/data.json` for initial setup
- `.obsidian/websync-folders.json`

This version excludes its own plugin files from automatic sync. Any future
upgrade must be installed and verified independently on every device; simply
restarting Obsidian will not install an update. BRAT can provide a manual
one-click update on each device after one-time installation and configuration.

Do not reconnect an old mobile client to a migrated production service until a
tested upgrade, compatibility and rollback plan is in place.

Isolated mobile testing requires a disposable test vault and service:

1. Use the bootstrap sync once to place WebSync on the phone.
2. Enable WebSync.
3. Let WebSync connect and pull synthetic test content.
4. Fully quit and reopen Obsidian after manually installing plugin code.
5. Keep any bootstrap tool disabled or pull-only to avoid double-sync conflicts.

## Experimental releases and BRAT

This project is not in the Obsidian community plugin catalog, so Obsidian's
native community-plugin update checker cannot update it directly. For an
isolated test vault, install the community plugin **BRAT**, add
`Tienching/obsidian-websync`, and select `latest` rather than a frozen version.
BRAT reads GitHub releases (including prereleases) and provides an update
command or button. Install and configure BRAT separately on each device; WebSync
does not distribute its own executable files. Before updating, independently
back up the vault and device sync state, wait for the queue to drain, and check
the release notes and compatibility. Verify one device before updating another.

Releases are marked prerelease, not a guarantee of production readiness. To make one,
update `manifest.json`, `package.json`, `package-lock.json`, and `versions.json`
to the same version and push the changes to `main`, or push a tag
that exactly matches the version without a `v` prefix. The prerelease workflow
runs the checks, creates the matching tag if necessary, and publishes
`main.js`, `manifest.json`, and `styles.css` as separate release assets; it
refuses inconsistent metadata, marks releases as prereleases, never replaces an
existing release, and refuses an existing tag pointing to a different commit.
GitHub Actions must be enabled and allowed to create releases. Inspect the
workflow and the published assets before relying on the release.

## Empty Folder Sync

Object stores and file manifests do not naturally preserve empty folders. WebSync records folder structure in:

```text
.obsidian/websync-folders.json
```

The plugin automatically updates this file after local folder create, delete, or rename events, and during startup scans. When another device receives it, WebSync creates the declared folders locally. `.obsidian` folders and trash folders are excluded from this manifest.

## Case-Only Renames

Case-only renames, such as `WIKI` to `Wiki`, are risky on case-insensitive filesystems. The plugin moves clean local files to trash for remote tombstones and blocks deletion when it conflicts with a local edit. In an isolated test it is still safer to:

1. Ensure all devices have the latest plugin.
2. Apply the rename on one canonical device.
3. Let the remote manifest carry delete tombstones for the old path.
4. Restart mobile Obsidian after plugin updates.

## Verification

Run all checks:

```bash
npm run typecheck
npm test
npm run build
```

Current test coverage includes:

- path normalization and sync exclusions
- manifest store put/delete/conflict behavior
- operation log behavior
- sync hub protocol behavior
- adaptive debounce behavior
- Markdown three-way merge behavior
- plugin conflict preservation
- remote tombstone deletion
- empty parent-folder pruning
- declared empty-folder creation

## Notes

This is a private sync system, not a public Obsidian community plugin release yet. Before sharing broadly, add a proper pairing flow so users do not need to copy plugin `data.json`, and replace the shared token model with per-device credentials.
