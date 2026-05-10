# Obsidian WebSync

WebSync is a private realtime sync stack for an Obsidian vault. It is designed for a personal multi-device setup where a lightweight Obsidian plugin talks to a Node.js sync service, and the service persists files plus the manifest in Tencent COS.

The important design choice is that COS credentials never live in the Obsidian plugin. Clients only know the WebSocket endpoint, vault id, and sync token.

## Architecture

```text
Obsidian plugin
  - Watches vault file changes.
  - Sends local changes over WebSocket.
  - Pulls remote changes and writes them to the vault.
  - Keeps an offline queue and conflict copies.
  - Syncs WebSync's own plugin files after bootstrap.

Node sync service
  - Authenticates clients with a shared token.
  - Maintains revisioned manifest state.
  - Broadcasts realtime changes over WebSocket.
  - Serves chunked manifest/file HTTP endpoints.
  - Writes files and manifest snapshots to COS.

Tencent COS
  - Stores durable files under COS_PREFIX/files/.
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

Generated build output goes to `dist/` and is ignored by git.

## Current Behavior

- Realtime sync uses WebSocket.
- Startup sync scans local files and reconciles with the remote manifest.
- Offline local changes are queued.
- Remote changes are pulled and written locally.
- Conflicts are preserved as `(... conflict from DEVICE TIMESTAMP)` files.
- Conflict device names are resolved automatically from the local host/platform; they are not user-configured plugin settings.
- Empty folders are synced through `.obsidian/websync-folders.json`.
- Snapshot tombstones delete local files and prune empty parent folders.
- `.obsidian` sync is intentionally narrow:
  - synced: `.obsidian/community-plugins.json`
  - synced: `.obsidian/websync-folders.json`
  - synced: `.obsidian/plugins/websync/main.js`
  - synced: `.obsidian/plugins/websync/manifest.json`
  - synced: `.obsidian/plugins/websync/styles.css`
  - not synced: WebSync `data.json`, other plugins, workspaces, appearance, app config, and other device-local Obsidian config

## Requirements

- Node.js 20+
- npm
- Tencent COS bucket
- A server reachable by HTTPS/WSS
- Obsidian desktop or mobile

## Setup

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

Never commit `.env`.

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

## Install Plugin Locally

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

## Run Server

After building:

```bash
node dist/server/index.cjs
```

For systemd, adapt:

```text
deploy/systemd/obsidian-sync.service
```

The production deployment should put Caddy, Nginx, or another reverse proxy in front of the service and expose:

```text
https://your-domain/healthz
wss://your-domain/sync
```

## Seed Remote State

Seed through the live sync service:

```bash
OBS_SYNC_TOKEN=your-token npm run seed:vault
```

Directly seed COS and optionally wipe the COS prefix first:

```bash
COS_BUCKET=your-cos-bucket \
COS_REGION=ap-guangzhou \
COS_PREFIX=_websync \
COS_SECRET_ID=... \
COS_SECRET_KEY=... \
SEED_WIPE=true \
SEED_WIPE_CONFIRM=_websync \
npm run seed:cos
```

`seed:cos` is useful when resetting a prefix cleanly. It refuses to wipe unless `SEED_WIPE_CONFIRM` matches the target prefix.

## Mobile Bootstrap

If a mobile device does not have WebSync installed yet, it needs a bootstrap path. In the current deployment Remotely Save is used only to deliver:

- `.obsidian/community-plugins.json`
- `.obsidian/plugins/websync/`
- `.obsidian/plugins/websync/data.json` for initial setup
- `.obsidian/websync-folders.json`

After WebSync is installed and enabled, WebSync can update its own plugin files. Obsidian still needs a full restart before newly downloaded plugin code is loaded.

If a mobile client already has an old WebSync config and the bootstrap tool is unavailable, keep the production `OBS_SYNC_VAULT_ID` as the canonical vault id and temporarily put the old mobile value in `OBS_SYNC_VAULT_ALIASES`. This lets the stale client reconnect long enough to download the current plugin and vault content without exposing COS credentials.

Recommended mobile flow:

1. Use the bootstrap sync once to place WebSync on the phone.
2. Enable WebSync.
3. Let WebSync connect and pull updates.
4. Fully quit and reopen Obsidian so the latest WebSync code is loaded.
5. Keep the bootstrap tool disabled or pull-only to avoid double-sync conflicts.

## Empty Folder Sync

Object stores and file manifests do not naturally preserve empty folders. WebSync records folder structure in:

```text
.obsidian/websync-folders.json
```

When the plugin sees this file, it creates the declared folders locally. Regenerate this file after changing the intended empty-folder skeleton.

## Case-Only Renames

Case-only renames, such as `WIKI` to `Wiki`, are risky on case-insensitive filesystems. The plugin now handles remote tombstones by deleting local files and pruning empty parent folders, but operationally it is still safer to:

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
- sync hub protocol behavior
- plugin conflict preservation
- remote tombstone deletion
- empty parent-folder pruning
- declared empty-folder creation

## Notes

This is a private sync system, not a public Obsidian community plugin release yet. Before sharing broadly, add a proper pairing flow so users do not need to copy plugin `data.json`, and replace the shared token model with per-device credentials.
