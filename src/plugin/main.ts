import { Notice, Plugin } from "obsidian";
import { loadLocalState, LocalSyncState, saveLocalState } from "./localState";
import { ForceScanOptions, SyncEngine, SyncStatusSnapshot } from "./syncEngine";
import { createDefaultData, SyncPluginData, WebSyncSettingTab } from "./settings";

export default class WebSyncPlugin extends Plugin {
  data: SyncPluginData = createDefaultData();
  private localState: LocalSyncState = loadLocalState(this.data.settings.vaultId);
  private engine?: SyncEngine;
  private statusEl?: HTMLElement;

  async onload(): Promise<void> {
    this.data = mergeData(createDefaultData(), (await this.loadData()) as Partial<SyncPluginData> | null);
    this.localState = loadLocalState(this.data.settings.vaultId);
    await this.savePluginData();

    this.statusEl = this.addStatusBarItem();
    this.setStatus("sync loading");

    this.engine = new SyncEngine({
      app: this.app,
      getSettings: () => this.data.settings,
      getState: () => this.localState,
      save: () => this.savePluginData(),
      setStatus: (status) => this.setStatus(status),
      registerEvent: (eventRef) => this.registerEvent(eventRef)
    });

    this.addSettingTab(new WebSyncSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "WebSync", () => {
      void runManualForceScan(this.engine);
    });

    this.addCommand({
      id: "connect",
      name: "Connect sync service",
      callback: () => this.engine?.connect()
    });
    this.addCommand({
      id: "force-scan",
      name: "Force local scan",
      callback: () => void runManualForceScan(this.engine)
    });
    this.addCommand({
      id: "show-diagnostics",
      name: "Show sync diagnostics",
      callback: () => {
        if (!this.engine) {
          new Notice("WebSync is not ready");
          return;
        }
        new Notice(formatStatusSnapshot(this.engine.getStatusSnapshot()), 12_000);
      }
    });

    this.engine.start();
  }

  onunload(): void {
    this.engine?.stop();
  }

  async savePluginData(): Promise<void> {
    saveLocalState(this.data.settings.vaultId, this.localState);
    await this.saveData(this.data);
  }

  setStatus(status: string): void {
    if (this.statusEl) {
      this.statusEl.setText(status);
    }
  }
}

interface ManualForceScanEngine {
  forceScan(options?: ForceScanOptions): Promise<void>;
}

export async function runManualForceScan(engine: ManualForceScanEngine | undefined): Promise<void> {
  if (!engine) {
    new Notice("WebSync is not ready");
    return;
  }

  try {
    await engine.forceScan({ waitForIdle: true, idleTimeoutMs: 30_000 });
    new Notice("WebSync sync complete");
  } catch (error) {
    new Notice(`WebSync sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatStatusSnapshot(snapshot: SyncStatusSnapshot): string {
  const lines = [
    `WebSync: ${snapshot.status}`,
    `Queue: ${snapshot.pendingOps} pending, ${snapshot.inflightOps} inflight`
  ];
  if (snapshot.remoteRevision !== undefined) {
    lines.push(`Remote revision: ${snapshot.remoteRevision}`);
  }
  if (snapshot.lastSyncedAt) {
    lines.push(`Last synced: ${snapshot.lastSyncedAt}`);
  }
  if (snapshot.lastError) {
    lines.push(`Last error: ${snapshot.lastError}`);
  }
  if (snapshot.queuedPaths.length > 0) {
    lines.push(`Queued: ${snapshot.queuedPaths.slice(0, 3).join(", ")}`);
  }
  if (snapshot.inflightPaths.length > 0) {
    lines.push(`Inflight: ${snapshot.inflightPaths.slice(0, 3).join(", ")}`);
  }
  return lines.join("\n");
}

function mergeData(defaults: SyncPluginData, loaded: Partial<SyncPluginData> | null): SyncPluginData {
  const settings = {
    ...defaults.settings,
    ...(loaded?.settings ?? {})
  };
  delete (settings as SyncPluginData["settings"] & { deviceName?: string }).deviceName;
  settings.syncedPluginIds = Array.isArray(settings.syncedPluginIds) ? settings.syncedPluginIds : [];
  return {
    settings
  };
}
