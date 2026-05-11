import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { ManifestFileEntry, ManifestSnapshot, RemoteChangeMessage } from "../shared/protocol";
import { normalizeVaultPath } from "../shared/pathRules";

interface VaultMirrorOptions {
  vaultPath: string;
  statePath: string;
  conflictDir: string;
  fetchFile(path: string): Promise<Buffer>;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

interface MirrorFileState {
  hash: string;
  revision: number;
  deleted?: boolean;
}

interface MirrorState {
  knownFiles: Record<string, MirrorFileState>;
}

const FOLDER_MANIFEST_PATH = ".obsidian/websync-folders.json";

export class VaultMirror {
  private stateLoaded = false;
  private state: MirrorState = { knownFiles: {} };
  private readonly vaultPath: string;
  private readonly logger: Pick<Console, "log" | "warn" | "error">;

  constructor(private readonly options: VaultMirrorOptions) {
    this.vaultPath = path.resolve(options.vaultPath);
    this.logger = options.logger ?? console;
  }

  async applyManifest(manifest: ManifestSnapshot): Promise<void> {
    await this.loadState();
    const entries = Object.values(manifest.files).sort((a, b) => a.revision - b.revision || a.path.localeCompare(b.path));
    for (const entry of entries) {
      await this.applyEntry(entry);
    }
    await this.ensureDeclaredFolders();
    await this.saveState();
  }

  async applyRemoteChange(message: RemoteChangeMessage): Promise<void> {
    await this.loadState();
    await this.applyEntry(message.entry, message.contentBase64 ? Buffer.from(message.contentBase64, "base64") : undefined);
    await this.saveState();
  }

  private async applyEntry(entryInput: ManifestFileEntry, content?: Buffer): Promise<void> {
    const entry = { ...entryInput, path: normalizeVaultPath(entryInput.path) };
    if (!this.shouldApply(entry)) {
      return;
    }

    if (entry.deleted) {
      await this.deleteLocalFile(entry);
      this.state.knownFiles[entry.path] = knownFromEntry(entry);
      return;
    }

    const body = content ?? await this.options.fetchFile(entry.path);
    await this.writeLocalFile(entry, body);
    this.state.knownFiles[entry.path] = knownFromEntry(entry);
    if (entry.path === FOLDER_MANIFEST_PATH) {
      await this.ensureDeclaredFolders();
    }
  }

  private shouldApply(entry: ManifestFileEntry): boolean {
    const known = this.state.knownFiles[entry.path];
    return !known || entry.revision > known.revision;
  }

  private async writeLocalFile(entry: ManifestFileEntry, content: Buffer): Promise<void> {
    const absolute = this.toAbsolutePath(entry.path);
    const localHash = await hashFileIfExists(absolute);
    if (localHash === entry.hash) {
      return;
    }

    await this.preserveDirtyLocal(entry.path, entry.hash);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }

  private async deleteLocalFile(entry: ManifestFileEntry): Promise<void> {
    const absolute = this.toAbsolutePath(entry.path);
    if (!existsSync(absolute)) {
      return;
    }
    await this.preserveDirtyLocal(entry.path);
    await rm(absolute, { force: true });
  }

  private async preserveDirtyLocal(vaultFilePath: string, incomingHash?: string): Promise<void> {
    const absolute = this.toAbsolutePath(vaultFilePath);
    const localHash = await hashFileIfExists(absolute);
    if (!localHash || localHash === incomingHash) {
      return;
    }

    const known = this.state.knownFiles[vaultFilePath];
    if (known && !known.deleted && known.hash === localHash) {
      return;
    }

    const conflictPath = path.join(this.options.conflictDir, timestamp(), vaultFilePath);
    await mkdir(path.dirname(conflictPath), { recursive: true });
    await copyFile(absolute, conflictPath);
    this.logger.warn(`Preserved dirty mirror file before remote apply: ${vaultFilePath} -> ${conflictPath}`);
  }

  private async ensureDeclaredFolders(): Promise<void> {
    const manifestPath = this.toAbsolutePath(FOLDER_MANIFEST_PATH);
    if (!existsSync(manifestPath)) {
      return;
    }
    let parsed: { folders?: unknown };
    try {
      parsed = JSON.parse(await readFile(manifestPath, "utf8")) as { folders?: unknown };
    } catch {
      return;
    }

    if (!Array.isArray(parsed.folders)) {
      return;
    }
    const folders = parsed.folders
      .filter((folder): folder is string => typeof folder === "string")
      .map((folder) => normalizeVaultPath(folder))
      .filter((folder) => folder && !folder.startsWith(".obsidian"))
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));

    for (const folder of folders) {
      await mkdir(this.toAbsolutePath(folder), { recursive: true });
    }
  }

  private async loadState(): Promise<void> {
    if (this.stateLoaded) {
      return;
    }
    try {
      this.state = JSON.parse(await readFile(this.options.statePath, "utf8")) as MirrorState;
      this.state.knownFiles ??= {};
    } catch {
      this.state = { knownFiles: {} };
    }
    this.stateLoaded = true;
  }

  private async saveState(): Promise<void> {
    await mkdir(path.dirname(this.options.statePath), { recursive: true });
    await writeFile(this.options.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  private toAbsolutePath(vaultFilePath: string): string {
    const absolute = path.resolve(this.vaultPath, normalizeVaultPath(vaultFilePath));
    if (absolute !== this.vaultPath && !absolute.startsWith(`${this.vaultPath}${path.sep}`)) {
      throw new Error(`Path escapes vault: ${vaultFilePath}`);
    }
    return absolute;
  }
}

function knownFromEntry(entry: ManifestFileEntry): MirrorFileState {
  return {
    hash: entry.hash,
    revision: entry.revision,
    deleted: entry.deleted || undefined
  };
}

async function hashFileIfExists(absolute: string): Promise<string | undefined> {
  try {
    return sha256(await readFile(absolute));
  } catch {
    return undefined;
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(".", "-");
}
