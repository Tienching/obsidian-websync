import { Notice, Plugin } from "obsidian";
import { loadLocalState, LocalSyncState, saveLocalState } from "./localState";
import { SyncEngine } from "./syncEngine";
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
      void this.engine?.forceScan();
      new Notice("WebSync scan queued");
    });

    this.addCommand({
      id: "connect",
      name: "Connect sync service",
      callback: () => this.engine?.connect()
    });
    this.addCommand({
      id: "force-scan",
      name: "Force local scan",
      callback: () => void this.engine?.forceScan()
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

function mergeData(defaults: SyncPluginData, loaded: Partial<SyncPluginData> | null): SyncPluginData {
  return {
    settings: {
      ...defaults.settings,
      ...(loaded?.settings ?? {})
    }
  };
}
